// public/js/auth/two-factor.js

"use strict";

var TwoFactor = (function () {
  var form = document.querySelector("#kt_sign_in_two_factor_form");
  var submitButton = document.querySelector("#kt_sign_in_two_factor_submit");
  var resendButton = document.querySelector("#kt_resend_otp");
  var inputs;

  function getCsrfToken() {
    if (!form) return "";

    var csrfInput = form.querySelector('input[name="_csrf"]');

    return csrfInput ? csrfInput.value : "";
  }

  function handleSubmit() {
    form.addEventListener("submit", function (e) {
      e.preventDefault();

      if (submitButton.disabled) return;

      var isValid = inputs.length === 6;

      inputs.forEach(function (input) {
        if (input.value === "" || input.value.length === 0) {
          isValid = false;
        }
      });

      if (!isValid) {
        Swal.fire({
          text: "Please enter a valid security code and try again.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: { confirmButton: "btn fw-bold btn-light-primary" },
        }).then(function () {
          KTUtil.scrollTop();
        });

        return;
      }

      submitButton.setAttribute("data-kt-indicator", "on");
      submitButton.disabled = true;

      var otp = inputs
        .map(function (input) {
          return input.value;
        })
        .join("");

      axios
        .post("/two-factor/verify", {
          otp: otp,
          _csrf: getCsrfToken(),
        })
        .then(function (response) {
          var data = response.data || {};

          if (!data.success || !data.redirectUrl) {
            throw new Error(
              data.message || "Verification completed, but no redirect was returned."
            );
          }

          Swal.fire({
            text: data.message,
            icon: "success",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn btn-primary" },
          }).then(function () {
            window.location.href = data.redirectUrl;
          });
        })
        .catch(function (error) {
          Swal.fire({
            text:
              error.response?.data?.message ||
              error.message ||
              "Please enter a valid security code and try again.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn fw-bold btn-light-primary" },
          }).then(function () {
            KTUtil.scrollTop();
          });
        })
        .then(function () {
          submitButton.removeAttribute("data-kt-indicator");
          submitButton.disabled = false;
        });
    });
  }

  function handleAutoFocus() {
    if (!inputs.length) return;

    inputs[0].focus();

    inputs.forEach(function (input, index) {
      input.addEventListener("input", function () {
        this.value = this.value.replace(/[^0-9]/g, "").slice(0, 1);

        if (this.value.length === 1 && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      input.addEventListener("keydown", function (e) {
        if (e.key === "Backspace" && this.value === "" && index > 0) {
          inputs[index - 1].focus();
        }
      });

      input.addEventListener("paste", function (e) {
        e.preventDefault();

        var pastedData = e.clipboardData
          .getData("text")
          .replace(/[^0-9]/g, "")
          .slice(0, 6);

        pastedData.split("").forEach(function (digit, idx) {
          if (inputs[idx]) inputs[idx].value = digit;
        });

        var nextEmpty = inputs.find(function (input) {
          return input.value === "";
        });

        if (nextEmpty) {
          nextEmpty.focus();
        } else {
          inputs[inputs.length - 1].focus();
        }
      });
    });
  }

  function handleResend() {
    if (!resendButton) return;

    resendButton.addEventListener("click", function (e) {
      e.preventDefault();

      if (resendButton.classList.contains("disabled")) return;

      resendButton.classList.add("disabled");

      axios
        .post("/two-factor/resend", {
          _csrf: getCsrfToken(),
        })
        .then(function (response) {
          Swal.fire({
            text: response.data.message,
            icon: "success",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn btn-primary" },
          });

          setTimeout(function () {
            resendButton.classList.remove("disabled");
          }, 60000);
        })
        .catch(function (error) {
          resendButton.classList.remove("disabled");

          Swal.fire({
            text: error.response?.data?.message || "Failed to resend OTP. Please try again.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn btn-primary" },
          });
        });
    });
  }

  return {
    init: function () {
      if (!form || !submitButton) return;

      var rawInputs = form.querySelectorAll('input[maxlength="1"]');

      rawInputs.forEach(function (input) {
        if (input.inputmask) {
          input.inputmask.remove();
        }
      });

      inputs = [].slice.call(rawInputs);

      handleSubmit();
      handleAutoFocus();
      handleResend();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  TwoFactor.init();
});
