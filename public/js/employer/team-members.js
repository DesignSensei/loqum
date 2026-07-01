// public/js/employer/team-members.js

"use strict";

var TeamMembers = (function () {
  var viewModalElement;

  var editForm;
  var editSubmitButton;
  var editRoleSelect;
  var editStatusSelect;
  var editBranchField;
  var editBranchSelect;
  var editModalElement;
  var editValidator;

  var removeForm;
  var removeSubmitButton;
  var removeReasonInput;
  var removeModalElement;

  function roleRequiresBranch(role) {
    return role === "branch_manager" || role === "branch_staff";
  }

  function getCsrfToken() {
    var csrfInput =
      document.querySelector('#kt_edit_team_member_form input[name="_csrf"]') ||
      document.querySelector('#kt_remove_team_member_form input[name="_csrf"]');

    return csrfInput ? csrfInput.value : "";
  }

  function setButtonLoading(button, isLoading) {
    if (!button) return;

    if (isLoading) {
      button.setAttribute("data-kt-indicator", "on");
      button.disabled = true;
      return;
    }

    button.removeAttribute("data-kt-indicator");
    button.disabled = false;
  }

  function setActionLoading(element, isLoading) {
    if (!element) return;

    if (isLoading) {
      element.classList.add("disabled");
      element.setAttribute("aria-disabled", "true");
      return;
    }

    element.classList.remove("disabled");
    element.removeAttribute("aria-disabled");
  }

  function isActionLoading(element) {
    return element && element.classList.contains("disabled");
  }

  function setText(selector, value) {
    var element = document.querySelector(selector);

    if (!element) return;

    element.textContent = value || "-";
  }

  function setBadge(selector, label, badgeClass) {
    var element = document.querySelector(selector);

    if (!element) return;

    element.className = "badge " + (badgeClass || "badge-light-secondary");
    element.textContent = label || "-";
  }

  function showModal(modalElement) {
    if (!modalElement || typeof bootstrap === "undefined") return;

    var modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.show();
  }

  function initializeSelect2() {
    if (!window.jQuery || !window.jQuery.fn.select2) return;

    ["#editTeamMemberRole", "#editTeamMemberStatus", "#editTeamMemberBranchSelect"].forEach(
      function (selector) {
        var element = window.jQuery(selector);

        if (!element.length || element.data("select2")) return;

        element.select2({
          dropdownParent: window.jQuery("#editTeamMemberModal"),
          width: "100%",
        });
      }
    );
  }

  function setSelectValue(select, value) {
    if (!select) return;

    select.value = value || "";

    if (window.jQuery && window.jQuery(select).data("select2")) {
      window
        .jQuery(select)
        .val(value || "")
        .trigger("change");
    }
  }

  function setSelectValues(select, values) {
    if (!select) return;

    var cleanValues = Array.isArray(values)
      ? values.map(function (value) {
          return String(value);
        })
      : [];

    if (window.jQuery && window.jQuery(select).data("select2")) {
      window.jQuery(select).val(cleanValues).trigger("change");
      return;
    }

    Array.from(select.options).forEach(function (option) {
      option.selected = cleanValues.includes(String(option.value));
    });
  }

  function getSelectedBranchIds() {
    if (!editBranchSelect) return [];

    if (window.jQuery && window.jQuery(editBranchSelect).data("select2")) {
      return window.jQuery(editBranchSelect).val() || [];
    }

    return Array.from(editBranchSelect.selectedOptions).map(function (option) {
      return option.value;
    });
  }

  function clearSelectedBranches() {
    setSelectValues(editBranchSelect, []);
  }

  function setSelectedBranches(branches) {
    var branchIds = (branches || []).map(function (assignment) {
      return String(assignment.branchId || "");
    });

    setSelectValues(editBranchSelect, branchIds);
  }

  function toggleBranchField(roleSelect, branchField, branchSelect) {
    if (!roleSelect || !branchField) return;

    if (roleRequiresBranch(roleSelect.value)) {
      branchField.classList.remove("d-none");

      if (branchSelect) {
        branchSelect.disabled = false;

        if (window.jQuery && window.jQuery(branchSelect).data("select2")) {
          window.jQuery(branchSelect).prop("disabled", false).trigger("change.select2");
        }
      }

      return;
    }

    branchField.classList.add("d-none");

    if (branchSelect) {
      branchSelect.disabled = true;
      setSelectValues(branchSelect, []);

      if (window.jQuery && window.jQuery(branchSelect).data("select2")) {
        window.jQuery(branchSelect).prop("disabled", true).trigger("change.select2");
      }
    }
  }

  function getValidationConfig(roleSelect) {
    return {
      fields: {
        role: {
          validators: {
            notEmpty: {
              message: "Please select a role.",
            },
          },
        },

        accountStatus: {
          validators: {
            notEmpty: {
              message: "Please select a status.",
            },
          },
        },

        branchIds: {
          validators: {
            callback: {
              message: "Please select at least one branch.",
              callback: function () {
                if (!roleSelect) return true;

                if (!roleRequiresBranch(roleSelect.value)) {
                  return true;
                }

                return getSelectedBranchIds().length > 0;
              },
            },
          },
        },
      },

      plugins: {
        excluded: new FormValidation.plugins.Excluded({
          excluded: function (field, element) {
            return element.disabled || element.closest(".d-none") !== null;
          },
        }),

        trigger: new FormValidation.plugins.Trigger(),

        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row",
          eleInvalidClass: "",
          eleValidClass: "",
        }),
      },
    };
  }

  function showSuccess(message) {
    return Swal.fire({
      text: message,
      icon: "success",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function showError(message) {
    return Swal.fire({
      text: message,
      icon: "error",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function showWarning(message) {
    return Swal.fire({
      text: message,
      icon: "warning",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function renderViewBranches(branches) {
    var container = document.querySelector(".js-view-team-member-branches");

    if (!container) return;

    if (!branches || branches.length === 0) {
      container.innerHTML = '<div class="text-muted">No branch assignment.</div>';
      return;
    }

    container.innerHTML = branches
      .map(function (assignment) {
        var branchName = assignment.branchName || "Unknown branch";
        var branchLocation = [assignment.branchState, assignment.branchLga]
          .filter(Boolean)
          .join(" • ");
        var roleLabel = assignment.roleLabel || "Branch Staff";

        return (
          '<div class="border rounded p-4 mb-3">' +
          '<div class="d-flex justify-content-between align-items-start gap-3">' +
          "<div>" +
          '<div class="fw-bold text-gray-900">' +
          branchName +
          "</div>" +
          '<div class="text-muted fs-7">' +
          (branchLocation || "No location added") +
          "</div>" +
          "</div>" +
          '<span class="badge badge-light-primary">' +
          roleLabel +
          "</span>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  function fetchMember(url) {
    return axios.get(url).then(function (response) {
      return response.data.member;
    });
  }

  function populateViewModal(member) {
    setText(".js-view-team-member-name", member.name);
    setText(".js-view-team-member-email", member.email);

    setBadge(".js-view-team-member-role", member.roleLabel, member.roleBadgeClass);
    setBadge(".js-view-team-member-status", member.statusLabel, member.statusBadgeClass);

    renderViewBranches(member.branches || []);

    var removedSection = document.querySelector(".js-view-team-member-removed-section");

    if (removedSection) {
      if (member.isRemoved) {
        removedSection.classList.remove("d-none");
      } else {
        removedSection.classList.add("d-none");
      }
    }

    setText(".js-view-team-member-removal-reason", member.removalReason || "No reason provided.");
  }

  function populateEditModal(member, updateUrl) {
    if (!editForm) return;

    editForm.action = updateUrl || "";

    setText(".js-edit-team-member-name", member.name);
    setText(".js-edit-team-member-email", member.email);
    setText(".js-edit-team-member-subtitle", member.email || "Update team member access");

    setSelectValue(editRoleSelect, member.role || "");
    setSelectValue(editStatusSelect, member.accountStatus || "");

    toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);
    setSelectedBranches(member.branches || []);

    if (editValidator) {
      editValidator.resetForm(true);
    }
  }

  function populateRemoveModal(button) {
    if (!removeForm) return;

    removeForm.action = button.dataset.removeUrl || "";

    setText(".js-remove-team-member-name", button.dataset.memberName || "this team member");
    setText(".js-remove-team-member-email", button.dataset.memberEmail || "-");

    if (removeReasonInput) {
      removeReasonInput.value = "";
    }

    setButtonLoading(removeSubmitButton, false);
  }

  function initializeEditValidation() {
    if (!editForm || typeof FormValidation === "undefined") return;

    editValidator = FormValidation.formValidation(editForm, getValidationConfig(editRoleSelect));
  }

  function handleEditRoleChange() {
    if (!editRoleSelect) return;

    var onChange = function () {
      toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);

      if (editValidator) {
        editValidator.revalidateField("role");
        editValidator.revalidateField("branchIds");
      }
    };

    editRoleSelect.addEventListener("change", onChange);

    if (window.jQuery) {
      window.jQuery(editRoleSelect).on("change", onChange);
    }
  }

  function handleBranchSelectChange() {
    if (!editBranchSelect) return;

    var onChange = function () {
      if (editValidator) {
        editValidator.revalidateField("branchIds");
      }
    };

    editBranchSelect.addEventListener("change", onChange);

    if (window.jQuery) {
      window.jQuery(editBranchSelect).on("change", onChange);
    }
  }

  function buildEditPayload() {
    var data = Object.fromEntries(new FormData(editForm));
    var role = editRoleSelect ? editRoleSelect.value : "";

    data._csrf = getCsrfToken();
    data.role = role;
    data.accountStatus = editStatusSelect ? editStatusSelect.value : "";
    data.branchIds = roleRequiresBranch(role) ? getSelectedBranchIds() : [];

    return data;
  }

  function postEditForm() {
    if (!editForm || !editSubmitButton) return;

    if (!editForm.action) {
      showError("Team member could not be edited. Please refresh and try again.");
      return;
    }

    var data = buildEditPayload();

    if (roleRequiresBranch(data.role) && data.branchIds.length === 0) {
      showWarning("Branch managers and branch staff must be assigned to at least one branch.");
      return;
    }

    setButtonLoading(editSubmitButton, true);

    axios
      .post(editForm.action, data)
      .then(function (response) {
        setButtonLoading(editSubmitButton, false);

        showSuccess(response.data.message || "Team member updated successfully.").then(function () {
          window.location.href = response.data.redirectUrl || "/employer/business-profile?tab=team";
        });
      })
      .catch(function (error) {
        setButtonLoading(editSubmitButton, false);

        showError(error.response?.data?.message || "Unable to update team member.");
      });
  }

  function handleEditSubmit() {
    if (!editForm || !editSubmitButton) return;

    editForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (editSubmitButton.disabled) return;

      if (!editValidator) {
        postEditForm();
        return;
      }

      editValidator.validate().then(function (status) {
        if (status === "Valid") {
          postEditForm();
          return;
        }

        showError("Please make sure all required fields are correctly filled out.");
      });
    });
  }

  function handleViewButtons() {
    document.querySelectorAll(".js-view-team-member").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        if (isActionLoading(button)) return;

        var url = button.dataset.memberUrl || "";

        if (!url) return;

        setActionLoading(button, true);

        fetchMember(url)
          .then(function (member) {
            setActionLoading(button, false);
            populateViewModal(member);
            showModal(viewModalElement);
          })
          .catch(function (error) {
            setActionLoading(button, false);
            showError(error.response?.data?.message || "Unable to load team member.");
          });
      });
    });
  }

  function handleEditButtons() {
    document.querySelectorAll(".js-edit-team-member").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        if (isActionLoading(button)) return;

        var memberUrl = button.dataset.memberUrl || "";
        var updateUrl = button.dataset.updateUrl || "";

        if (!memberUrl || !updateUrl) return;

        setActionLoading(button, true);

        fetchMember(memberUrl)
          .then(function (member) {
            setActionLoading(button, false);
            populateEditModal(member, updateUrl);
            showModal(editModalElement);
          })
          .catch(function (error) {
            setActionLoading(button, false);
            showError(error.response?.data?.message || "Unable to load team member.");
          });
      });
    });
  }

  function handleRemoveButtons() {
    document.querySelectorAll(".js-remove-team-member").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        populateRemoveModal(button);
        showModal(removeModalElement);
      });
    });
  }

  function handleRemoveSubmit() {
    if (!removeForm || !removeSubmitButton) return;

    removeForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (removeSubmitButton.disabled) return;

      if (!removeForm.action) {
        showError("Team member could not be removed. Please refresh and try again.");
        return;
      }

      setButtonLoading(removeSubmitButton, true);

      var data = Object.fromEntries(new FormData(removeForm));
      data._csrf = getCsrfToken();

      axios
        .post(removeForm.action, data)
        .then(function (response) {
          setButtonLoading(removeSubmitButton, false);

          showSuccess(response.data.message || "Team member removed successfully.").then(
            function () {
              window.location.href =
                response.data.redirectUrl || "/employer/business-profile?tab=team";
            }
          );
        })
        .catch(function (error) {
          setButtonLoading(removeSubmitButton, false);

          showError(error.response?.data?.message || "Unable to remove team member.");
        });
    });
  }

  function resetEditForm() {
    if (!editForm) return;

    editForm.reset();
    editForm.action = "";

    setSelectValue(editRoleSelect, "");
    setSelectValue(editStatusSelect, "");
    clearSelectedBranches();

    toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);

    if (editValidator) {
      editValidator.resetForm(true);
    }

    setButtonLoading(editSubmitButton, false);
  }

  function resetRemoveForm() {
    if (!removeForm) return;

    removeForm.reset();
    removeForm.action = "";

    if (removeReasonInput) {
      removeReasonInput.value = "";
    }

    setButtonLoading(removeSubmitButton, false);
  }

  function handleModalReset() {
    if (editModalElement) {
      editModalElement.addEventListener("hidden.bs.modal", function () {
        resetEditForm();
      });
    }

    if (removeModalElement) {
      removeModalElement.addEventListener("hidden.bs.modal", function () {
        resetRemoveForm();
      });
    }
  }

  return {
    init: function () {
      viewModalElement = document.querySelector("#viewTeamMemberModal");

      editForm = document.querySelector("#kt_edit_team_member_form");
      editSubmitButton = document.querySelector("#kt_edit_team_member_submit");
      editRoleSelect = document.querySelector("#editTeamMemberRole");
      editStatusSelect = document.querySelector("#editTeamMemberStatus");
      editBranchField = document.querySelector("#editTeamMemberBranchField");
      editBranchSelect = document.querySelector("#editTeamMemberBranchSelect");
      editModalElement = document.querySelector("#editTeamMemberModal");

      removeForm = document.querySelector("#kt_remove_team_member_form");
      removeSubmitButton = document.querySelector("#kt_remove_team_member_submit");
      removeReasonInput = document.querySelector("#removeTeamMemberReason");
      removeModalElement = document.querySelector("#removeTeamMemberModal");

      if (editForm) {
        initializeSelect2();
        toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);
        initializeEditValidation();
        handleEditRoleChange();
        handleBranchSelectChange();
        handleEditSubmit();
      }

      if (removeForm) {
        handleRemoveSubmit();
      }

      handleViewButtons();
      handleEditButtons();
      handleRemoveButtons();
      handleModalReset();

      if (window.KTMenu) {
        KTMenu.createInstances();
      }
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  TeamMembers.init();
});
