// public/js/admin/subscription-plans.js

"use strict";

var AdminSubscriptionPlans = (function () {
  var baseUrl = "/admin/subscription-plans";
  var form = null;
  var submitButton = null;
  var busy = false;

  function field(name) {
    return form.elements.namedItem(name);
  }

  function setLoading(button, loading) {
    button.disabled = loading;

    if (loading) {
      button.setAttribute("data-kt-indicator", "on");
    } else {
      button.removeAttribute("data-kt-indicator");
    }
  }

  function showAlert(message, icon) {
    if (!window.Swal) {
      window.alert(message);
      return Promise.resolve();
    }

    return Swal.fire({
      text: message,
      icon: icon,
      buttonsStyling: false,
      confirmButtonText: "OK",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function confirmAction(message) {
    if (!window.Swal) {
      return Promise.resolve(window.confirm(message));
    }

    return Swal.fire({
      text: message,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Confirm",
      cancelButtonText: "Cancel",
      buttonsStyling: false,
      customClass: {
        confirmButton: "btn btn-primary",
        cancelButton: "btn btn-light",
      },
    }).then(function (result) {
      return result.isConfirmed;
    });
  }

  function getErrorMessage(error) {
    return error?.response?.data?.message ||
      "The subscription plan request could not be completed.";
  }

  function configureForm(mode, plan) {
    form.reset();

    var title = document.querySelector("#subscription_plan_modal_title");

    form.setAttribute("action", baseUrl);
    field("expectedRevision").value = "";

    ["code", "countryCode", "currency"].forEach(function (name) {
      field(name).readOnly = false;
    });

    if (mode === "create") {
      title.textContent = "Create subscription plan";
      return;
    }

    Object.keys(plan).forEach(function (name) {
      var input = field(name);

      if (input) {
        input.value = plan[name] == null ? "" : plan[name];
      }
    });

    ["code", "countryCode", "currency"].forEach(function (name) {
      field(name).readOnly = true;
    });

    if (mode === "edit") {
      title.textContent = "Edit draft subscription plan";

      form.setAttribute(
        "action",
        baseUrl + "/" + encodeURIComponent(plan.id) + "/update"
      );

      field("expectedRevision").value = plan.revision;
    } else {
      title.textContent = "Create new plan version";
    }
  }

  function bindModalActions() {
    document.querySelectorAll(".js-plan-create").forEach(function (button) {
      button.addEventListener("click", function () {
        if (!busy) configureForm("create", null);
      });
    });

    document.querySelectorAll(".js-plan-edit, .js-plan-version").forEach(function (button) {
      button.addEventListener("click", function () {
        if (busy) return;

        try {
          var plan = JSON.parse(button.dataset.plan);

          configureForm(
            button.classList.contains("js-plan-edit")
              ? "edit"
              : "version",
            plan
          );
        } catch (error) {
          showAlert("Unable to load plan details. Refresh the page.", "error");
        }
      });
    });
  }

  function bindFormSubmission() {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (busy || !form.reportValidity()) return;

      busy = true;
      setLoading(submitButton, true);

      try {
        var data = Object.fromEntries(new FormData(form));

        data.featureKeys = String(data.featureKeys || "")
          .split(/\r?\n/)
          .map(function (value) {
            return value.trim();
          })
          .filter(Boolean);

        if (!data.expectedRevision) {
          delete data.expectedRevision;
        }

        var response = await axios.post(form.action, data);

        if (response.data?.success !== true) {
          throw new Error("Unexpected response.");
        }

        await showAlert("Subscription plan draft saved.", "success");

        window.location.href = baseUrl;
      } catch (error) {
        busy = false;
        setLoading(submitButton, false);

        await showAlert(getErrorMessage(error), "error");
      }
    });
  }

  function bindPlanCommands() {
    document.querySelectorAll(".js-plan-command").forEach(function (button) {
      button.addEventListener("click", async function () {
        if (busy || button.disabled) return;

        var command = button.dataset.command;
        var planId = button.dataset.planId;

        if (
          !["activate", "retire"].includes(command) ||
          !/^[a-fA-F0-9]{24}$/.test(planId || "")
        ) {
          return;
        }

        busy = true;
        setLoading(button, true);

        try {
          var message = command === "activate"
            ? "Activate " + button.dataset.planName + " for new purchases?"
            : "Retire " + button.dataset.planName +
              "? Existing purchased subscription terms will remain unchanged.";

          if (!(await confirmAction(message))) {
            busy = false;
            setLoading(button, false);
            return;
          }

          var response = await axios.post(
            baseUrl + "/" + encodeURIComponent(planId) + "/" + command,
            {
              _csrf: field("_csrf").value,
              expectedRevision: button.dataset.revision,
            }
          );

          if (response.data?.success !== true) {
            throw new Error("Unexpected response.");
          }

          await showAlert(
            command === "activate"
              ? "Subscription plan activated."
              : "Subscription plan retired.",
            "success"
          );

          window.location.reload();
        } catch (error) {
          busy = false;
          setLoading(button, false);

          await showAlert(getErrorMessage(error), "error");
        }
      });
    });
  }

  return {
    init: function () {
      form = document.querySelector("#kt_subscription_plan_form");
      submitButton = document.querySelector("#kt_subscription_plan_submit");

      if (!form || !submitButton) return;

      bindModalActions();
      bindFormSubmission();
      bindPlanCommands();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminSubscriptionPlans.init();
});
