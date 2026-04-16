// public/js/two-factor.js

"use strict";

var TwoFactor = (function () {
  var form = document.querySelector("#kt_sing_in_two_factor_form");
  var submitButton = document.querySelector("#kt_sing_in_two_factor_submit");
  var resendButton = document.querySelector("#kt_resend_otp");
  var inputs;

  function handleSubmit() {
    submitButton.addEventListener("click", function (e) {
      e.preventDefault();

      var isValid = true;

      inputs.map(function (input) {
        if (input.value === "" || input.value.length === 0) {
          isValid = false;
        }
      });

      if (isValid) {
        submitButton.setAttribute("data-kt-indicator", "on");
        submitButton.disabled = true;

        const otp = inputs.map((input) => input.value).join("");

        axios
          .post("/two-factor/verify", { otp })
          .then(function (response) {
            Swal.fire({
              text: response.data.message,
              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",
              customClass: { confirmButton: "btn btn-primary" },
            }).then(function () {
              window.location.href = response.data.redirectUrl;
            });
          })
          .catch(function (error) {
            Swal.fire({
              text:
                error.response?.data?.message ||
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
      } else {
        Swal.fire({
          text: "Please enter a valid security code and try again.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: { confirmButton: "btn fw-bold btn-light-primary" },
        }).then(function () {
          KTUtil.scrollTop();
        });
      }
    });
  }

  function handleAutoFocus() {
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
    });

    // Paste on any input
    inputs.forEach(function (input) {
      input.addEventListener("paste", function (e) {
        e.preventDefault();
        const pastedData = e.clipboardData
          .getData("text")
          .replace(/[^0-9]/g, "")
          .slice(0, 6);

        pastedData.split("").forEach(function (digit, idx) {
          if (inputs[idx]) inputs[idx].value = digit;
        });

        const nextEmpty = inputs.find((input) => input.value === "");
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
      resendButton.classList.add("disabled");

      axios
        .post("/two-factor/resend")
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
            text:
              error.response?.data?.message ||
              "Failed to resend OTP. Please try again.",
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
      // Destroy inputmask on OTP inputs if it exists
      var rawInputs = form.querySelectorAll('input[maxlength="1"]');
      rawInputs.forEach(function (input) {
        if (input.inputmask) {
          input.inputmask.remove();
        }
      });

      inputs = [].slice.call(rawInputs);
      console.log("inputs found:", inputs.length);

      handleSubmit();
      handleAutoFocus();
      handleResend();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  TwoFactor.init();
});
