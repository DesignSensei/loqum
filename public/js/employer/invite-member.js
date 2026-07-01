// public/js/employer/invite-member.js

"use strict";

var InviteMember = (function () {
  var createForm;
  var createSubmitButton;
  var createRoleSelect;
  var createBranchField;
  var createBranchSelect;
  var createModalElement;
  var createValidator;

  var editForm;
  var editSubmitButton;
  var editInviteIdInput;
  var editEmailInput;
  var editRoleSelect;
  var editBranchField;
  var editBranchSelect;
  var editModalElement;
  var editValidator;

  function roleRequiresBranch(role) {
    return role === "branch_manager" || role === "branch_staff";
  }

  function getCsrfToken() {
    var csrfInput =
      document.querySelector('#kt_invite_member_form input[name="_csrf"]') ||
      document.querySelector('#kt_edit_invite_form input[name="_csrf"]');

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

  function toggleBranchField(roleSelect, branchField, branchSelect) {
    if (!roleSelect || !branchField || !branchSelect) return;

    if (roleRequiresBranch(roleSelect.value)) {
      branchField.classList.remove("d-none");
      branchSelect.disabled = false;
      return;
    }

    branchField.classList.add("d-none");
    branchSelect.disabled = true;
    setSelectValue(branchSelect, "");
  }

  function getValidationConfig(roleSelect, branchSelect) {
    return {
      fields: {
        email: {
          validators: {
            notEmpty: {
              message: "Email address is required.",
            },
            regexp: {
              regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
              message: "Please enter a valid email address.",
            },
          },
        },

        role: {
          validators: {
            notEmpty: {
              message: "Please select a role.",
            },
          },
        },

        branchId: {
          validators: {
            callback: {
              message: "Please select a branch.",
              callback: function () {
                if (!roleSelect) return true;

                if (!roleRequiresBranch(roleSelect.value)) {
                  return true;
                }

                return Boolean(branchSelect && branchSelect.value);
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

  function postForm(form, submitButton, fallbackSuccessMessage) {
    setButtonLoading(submitButton, true);

    var data = Object.fromEntries(new FormData(form));

    axios
      .post(form.action, data)
      .then(function (response) {
        setButtonLoading(submitButton, false);

        showSuccess(response.data.message || fallbackSuccessMessage).then(function () {
          window.location.reload();
        });
      })
      .catch(function (error) {
        setButtonLoading(submitButton, false);

        showError(error.response?.data?.message || "Request failed. Please try again.");
      });
  }

  function initializeCreateValidation() {
    if (!createForm || typeof FormValidation === "undefined") return;

    createValidator = FormValidation.formValidation(
      createForm,
      getValidationConfig(createRoleSelect, createBranchSelect)
    );
  }

  function initializeEditValidation() {
    if (!editForm || typeof FormValidation === "undefined") return;

    editValidator = FormValidation.formValidation(
      editForm,
      getValidationConfig(editRoleSelect, editBranchSelect)
    );
  }

  function resetCreateForm() {
    if (!createForm) return;

    createForm.reset();

    setSelectValue(createRoleSelect, "");
    setSelectValue(createBranchSelect, "");

    toggleBranchField(createRoleSelect, createBranchField, createBranchSelect);

    if (createValidator) {
      createValidator.resetForm(true);
    }

    setButtonLoading(createSubmitButton, false);
  }

  function resetEditForm() {
    if (!editForm) return;

    editForm.reset();
    editForm.action = "";

    if (editInviteIdInput) {
      editInviteIdInput.value = "";
    }

    setSelectValue(editRoleSelect, "");
    setSelectValue(editBranchSelect, "");

    toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);

    if (editValidator) {
      editValidator.resetForm(true);
    }

    setButtonLoading(editSubmitButton, false);
  }

  function handleCreateRoleChange() {
    if (!createRoleSelect) return;

    var onChange = function () {
      toggleBranchField(createRoleSelect, createBranchField, createBranchSelect);

      if (createValidator) {
        createValidator.revalidateField("role");
        createValidator.revalidateField("branchId");
      }
    };

    createRoleSelect.addEventListener("change", onChange);

    if (window.jQuery) {
      window.jQuery(createRoleSelect).on("change", onChange);
    }
  }

  function handleEditRoleChange() {
    if (!editRoleSelect) return;

    var onChange = function () {
      toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);

      if (editValidator) {
        editValidator.revalidateField("role");
        editValidator.revalidateField("branchId");
      }
    };

    editRoleSelect.addEventListener("change", onChange);

    if (window.jQuery) {
      window.jQuery(editRoleSelect).on("change", onChange);
    }
  }

  function handleCreateSubmit() {
    if (!createForm || !createSubmitButton) return;

    createForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (createSubmitButton.disabled) return;

      if (!createValidator) {
        postForm(createForm, createSubmitButton, "Invite sent successfully.");
        return;
      }

      createValidator.validate().then(function (status) {
        if (status === "Valid") {
          postForm(createForm, createSubmitButton, "Invite sent successfully.");
          return;
        }

        showError("Please make sure all required fields are correctly filled out.");
      });
    });
  }

  function handleEditSubmit() {
    if (!editForm || !editSubmitButton) return;

    editForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (editSubmitButton.disabled) return;

      if (!editForm.action) {
        showError("Invite could not be edited. Please refresh and try again.");
        return;
      }

      if (!editValidator) {
        postForm(editForm, editSubmitButton, "Invite updated and resent successfully.");
        return;
      }

      editValidator.validate().then(function (status) {
        if (status === "Valid") {
          postForm(editForm, editSubmitButton, "Invite updated and resent successfully.");
          return;
        }

        showError("Please make sure all required fields are correctly filled out.");
      });
    });
  }

  function handleEditButtons() {
    document.querySelectorAll(".js-edit-invite").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        var inviteId = button.dataset.inviteId || "";
        var email = button.dataset.inviteEmail || "";
        var role = button.dataset.inviteRole || "";
        var branchId = button.dataset.inviteBranchId || "";

        if (!editForm || !inviteId) return;

        editForm.action =
          "/employer/business-profile/invites/" + encodeURIComponent(inviteId) + "/update";

        if (editInviteIdInput) {
          editInviteIdInput.value = inviteId;
        }

        if (editEmailInput) {
          editEmailInput.value = email;
        }

        setSelectValue(editRoleSelect, role);
        setSelectValue(editBranchSelect, branchId);

        toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);

        if (editValidator) {
          editValidator.resetForm(true);
        }
      });
    });
  }

  function handleResendButtons() {
    document.querySelectorAll(".js-resend-invite").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        if (isActionLoading(button)) return;

        var inviteId = button.dataset.inviteId || "";
        var email = button.dataset.inviteEmail || "";

        if (!inviteId) return;

        Swal.fire({
          text: "Resend invite to " + email + "?",
          icon: "question",
          showCancelButton: true,
          buttonsStyling: false,
          confirmButtonText: "Yes, resend",
          cancelButtonText: "Cancel",
          customClass: {
            confirmButton: "btn btn-primary",
            cancelButton: "btn btn-light",
          },
        }).then(function (result) {
          if (!result.isConfirmed) return;

          setActionLoading(button, true);

          axios
            .post(
              "/employer/business-profile/invites/" + encodeURIComponent(inviteId) + "/resend",
              {
                _csrf: getCsrfToken(),
              }
            )
            .then(function (response) {
              setActionLoading(button, false);

              showSuccess(response.data.message || "Invite resent successfully.").then(function () {
                window.location.reload();
              });
            })
            .catch(function (error) {
              setActionLoading(button, false);

              showError(error.response?.data?.message || "Unable to resend invite.");
            });
        });
      });
    });
  }

  function handleRevokeButtons() {
    document.querySelectorAll(".js-revoke-invite").forEach(function (button) {
      button.addEventListener("click", function (e) {
        e.preventDefault();

        if (isActionLoading(button)) return;

        var inviteId = button.dataset.inviteId || "";
        var email = button.dataset.inviteEmail || "";

        if (!inviteId) return;

        Swal.fire({
          text: "Delete this invite for " + email + "? This will cancel the invite link.",
          icon: "warning",
          showCancelButton: true,
          buttonsStyling: false,
          confirmButtonText: "Yes, delete",
          cancelButtonText: "Cancel",
          customClass: {
            confirmButton: "btn btn-danger",
            cancelButton: "btn btn-light",
          },
        }).then(function (result) {
          if (!result.isConfirmed) return;

          setActionLoading(button, true);

          axios
            .post(
              "/employer/business-profile/invites/" + encodeURIComponent(inviteId) + "/revoke",
              {
                _csrf: getCsrfToken(),
              }
            )
            .then(function (response) {
              setActionLoading(button, false);

              showSuccess(response.data.message || "Invite deleted successfully.").then(
                function () {
                  window.location.reload();
                }
              );
            })
            .catch(function (error) {
              setActionLoading(button, false);

              showError(error.response?.data?.message || "Unable to delete invite.");
            });
        });
      });
    });
  }

  function handleModalReset() {
    if (createModalElement) {
      createModalElement.addEventListener("hidden.bs.modal", function () {
        resetCreateForm();
      });
    }

    if (editModalElement) {
      editModalElement.addEventListener("hidden.bs.modal", function () {
        resetEditForm();
      });
    }
  }

  return {
    init: function () {
      createForm = document.querySelector("#kt_invite_member_form");
      createSubmitButton = document.querySelector("#kt_invite_member_submit");
      createRoleSelect = document.querySelector("#inviteRoleSelect");
      createBranchField = document.querySelector("#inviteBranchField");
      createBranchSelect = document.querySelector("#inviteBranchSelect");
      createModalElement = document.querySelector("#inviteMemberModal");

      editForm = document.querySelector("#kt_edit_invite_form");
      editSubmitButton = document.querySelector("#kt_edit_invite_submit");
      editInviteIdInput = document.querySelector("#editInviteIdInput");
      editEmailInput = document.querySelector("#editInviteEmailInput");
      editRoleSelect = document.querySelector("#editInviteRoleSelect");
      editBranchField = document.querySelector("#editInviteBranchField");
      editBranchSelect = document.querySelector("#editInviteBranchSelect");
      editModalElement = document.querySelector("#editInviteModal");

      if (createForm) {
        toggleBranchField(createRoleSelect, createBranchField, createBranchSelect);
        initializeCreateValidation();
        handleCreateRoleChange();
        handleCreateSubmit();
      }

      if (editForm) {
        toggleBranchField(editRoleSelect, editBranchField, editBranchSelect);
        initializeEditValidation();
        handleEditRoleChange();
        handleEditSubmit();
      }

      handleEditButtons();
      handleResendButtons();
      handleRevokeButtons();
      handleModalReset();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  InviteMember.init();
});
