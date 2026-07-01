// public/js/auth/login.js

"use strict";

var LogIn = (function () {
  var form = document.querySelector("#kt_sign_in_form");
  var submitButton = document.querySelector("#kt_sign_in_submit");

  function setSubmitLoading(isLoading) {
    if (!submitButton) return;

    if (isLoading) {
      submitButton.setAttribute("data-kt-indicator", "on");
      submitButton.disabled = true;
      return;
    }

    submitButton.removeAttribute("data-kt-indicator");
    submitButton.disabled = false;
  }

  function handleLogIn() {
    if (!form || !submitButton) return;

    const validator = FormValidation.formValidation(form, {
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

        password: {
          validators: {
            notEmpty: {
              message: "Password is required.",
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

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      if (submitButton.disabled) return;

      validator.validate().then(function (status) {
        if (status !== "Valid") {
          Swal.fire({
            text: "Please make sure all required fields are correctly filled out.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: {
              confirmButton: "btn btn-primary",
            },
          });

          return;
        }

        setSubmitLoading(true);

        const data = Object.fromEntries(new FormData(form));

        axios
          .post(form.action, data)
          .then(function (response) {
            setSubmitLoading(false);

            Swal.fire({
              text: response.data.message,
              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",
              customClass: {
                confirmButton: "btn btn-primary",
              },
            }).then(function () {
              window.location.href = response.data.redirectUrl || "/login";
            });
          })
          .catch(function (error) {
            setSubmitLoading(false);

            Swal.fire({
              text: error.response?.data?.message || "Invalid email or password. Please try again.",
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
      handleLogIn();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  LogIn.init();
});
