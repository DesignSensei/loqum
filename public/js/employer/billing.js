// public/js/employer/billing.js

"use strict";

var EmployerBilling = (function () {
  var dvaSetupForm = null;
  var dvaSetupSubmitButton = null;

  var withdrawalAccountForm = null;
  var withdrawalAccountSubmitButton = null;

  var walletWithdrawalForm = null;
  var walletWithdrawalSubmitButton = null;

  function getErrorMessage(error, fallbackMessage) {
    return error?.response?.data?.message || error?.message || fallbackMessage;
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

  function showAlert({ text, icon, confirmButtonText = "Ok, got it!" }) {
    return Swal.fire({
      text,
      icon,
      buttonsStyling: false,
      confirmButtonText,
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function handleDVASetupSubmission() {
    dvaSetupForm = document.querySelector("#kt_dva_setup_form");
    dvaSetupSubmitButton = document.querySelector("#kt_dva_setup_submit");

    if (!dvaSetupForm || !dvaSetupSubmitButton) return;

    dvaSetupForm.addEventListener("submit", function (e) {
      e.preventDefault();

      setButtonLoading(dvaSetupSubmitButton, true);

      var formData = new FormData(dvaSetupForm);
      var data = Object.fromEntries(formData);

      axios
        .post(dvaSetupForm.action, data)
        .then(function (response) {
          setButtonLoading(dvaSetupSubmitButton, false);

          showAlert({
            text: response.data.message || "Wallet bank account setup requested successfully.",
            icon: "success",
          }).then(function () {
            window.location.href = response.data.redirectUrl || "/employer/billing";
          });
        })
        .catch(function (error) {
          setButtonLoading(dvaSetupSubmitButton, false);

          showAlert({
            text: getErrorMessage(error, "Unable to set up wallet bank account."),
            icon: "error",
          });
        });
    });
  }

  function handleWithdrawalAccountResolution() {
    withdrawalAccountForm = document.querySelector("#kt_withdrawal_account_form");

    if (!withdrawalAccountForm) return;

    var bankSelect = document.querySelector("#withdrawal_bank_select");
    var bankNameInput = document.querySelector("#withdrawal_bank_name");
    var accountNumberInput = document.querySelector("#withdrawal_account_number");
    var accountNameInput = document.querySelector("#withdrawal_account_name");
    var resolveHint = document.querySelector("#withdrawal_account_resolve_hint");

    var resolveTimer = null;

    function getCsrfToken() {
      var csrfInput = withdrawalAccountForm.querySelector('input[name="_csrf"]');

      return csrfInput ? csrfInput.value : "";
    }

    function setResolveHint(message, tone) {
      if (!resolveHint) return;

      var toneClassMap = {
        muted: "text-muted",
        success: "text-success",
        danger: "text-danger",
        warning: "text-warning",
      };

      resolveHint.className = (toneClassMap[tone] || "text-muted") + " fs-8 mt-2";

      resolveHint.textContent = message;
    }

    function syncSelectedBankName() {
      if (!bankSelect || !bankNameInput) return;

      var selectedOption = bankSelect.options[bankSelect.selectedIndex];

      bankNameInput.value = selectedOption?.dataset?.bankName || "";
    }

    function canResolveAccountName() {
      return Boolean(accountNameInput && accountNameInput.hasAttribute("readonly"));
    }

    function resolveAccountName() {
      if (!canResolveAccountName()) return;

      var paystackBankCode = bankSelect?.value || "";
      var accountNumber = accountNumberInput?.value?.replace(/\s+/g, "").trim() || "";

      accountNameInput.value = "";

      if (!paystackBankCode || accountNumber.length < 10) {
        setResolveHint(
          "Account name will be resolved automatically after you select a bank and enter a valid account number.",
          "muted"
        );
        return;
      }

      setResolveHint("Resolving account name...", "muted");

      axios
        .post("/employer/billing/resolve-withdrawal-account", {
          _csrf: getCsrfToken(),
          paystackBankCode,
          accountNumber,
        })
        .then(function (response) {
          accountNameInput.value = response.data.accountName || "";

          setResolveHint("Account name resolved.", "success");
        })
        .catch(function (error) {
          accountNameInput.value = "";

          setResolveHint(getErrorMessage(error, "Unable to resolve account name."), "danger");
        });
    }

    function scheduleResolve() {
      window.clearTimeout(resolveTimer);

      resolveTimer = window.setTimeout(function () {
        resolveAccountName();
      }, 500);
    }

    if (bankSelect) {
      bankSelect.addEventListener("change", function () {
        syncSelectedBankName();
        scheduleResolve();
      });

      if (window.jQuery && window.jQuery.fn.select2) {
        window.jQuery(bankSelect).on("change", function () {
          syncSelectedBankName();
          scheduleResolve();
        });
      }
    }

    if (accountNumberInput) {
      accountNumberInput.addEventListener("input", function () {
        accountNumberInput.value = accountNumberInput.value.replace(/\D/g, "").slice(0, 10);

        scheduleResolve();
      });
    }

    syncSelectedBankName();
  }

  function handleWithdrawalAccountSubmission() {
    withdrawalAccountForm = document.querySelector("#kt_withdrawal_account_form");

    withdrawalAccountSubmitButton = document.querySelector("#kt_withdrawal_account_submit");

    if (!withdrawalAccountForm || !withdrawalAccountSubmitButton) return;

    withdrawalAccountForm.addEventListener("submit", function (e) {
      e.preventDefault();

      var bankSelect = document.querySelector("#withdrawal_bank_select");
      var bankNameInput = document.querySelector("#withdrawal_bank_name");
      var accountNameInput = document.querySelector("#withdrawal_account_name");

      if (bankSelect && bankNameInput) {
        var selectedOption = bankSelect.options[bankSelect.selectedIndex];

        bankNameInput.value = selectedOption?.dataset?.bankName || "";
      }

      if (
        accountNameInput &&
        accountNameInput.hasAttribute("readonly") &&
        !accountNameInput.value.trim()
      ) {
        showAlert({
          text: "Please wait for the account name to be resolved before saving.",
          icon: "warning",
        });

        return;
      }

      setButtonLoading(withdrawalAccountSubmitButton, true);

      var formData = new FormData(withdrawalAccountForm);
      var data = Object.fromEntries(formData);

      axios
        .post(withdrawalAccountForm.action, data)
        .then(function (response) {
          setButtonLoading(withdrawalAccountSubmitButton, false);

          showAlert({
            text: response.data.message || "Withdrawal bank account saved successfully.",
            icon: "success",
          }).then(function () {
            window.location.href =
              response.data.redirectUrl || "/employer/billing#withdrawal-account";
          });
        })
        .catch(function (error) {
          setButtonLoading(withdrawalAccountSubmitButton, false);

          showAlert({
            text: getErrorMessage(error, "Unable to save withdrawal bank account."),
            icon: "error",
          });
        });
    });
  }

  function confirmWithdrawalAccountRemoval() {
    if (!window.Swal) {
      return Promise.resolve(window.confirm("Remove this withdrawal bank account?"));
    }

    return Swal.fire({
      text: "Remove this withdrawal bank account?",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, remove it",
      cancelButtonText: "Cancel",
      buttonsStyling: false,
      customClass: {
        confirmButton: "btn btn-danger",
        cancelButton: "btn btn-light",
      },
    }).then(function (result) {
      return result.isConfirmed;
    });
  }

  function confirmWalletWithdrawal() {
    if (!window.Swal) {
      return Promise.resolve(window.confirm("Submit this wallet withdrawal request?"));
    }

    return Swal.fire({
      text: "Submit this wallet withdrawal request?",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, submit withdrawal",
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

  function handleWithdrawalAccountRemoval() {
    var removeForm = document.querySelector("#kt_withdrawal_account_remove_form");
    var removeSubmitButton = document.querySelector("#kt_withdrawal_account_remove_submit");

    if (!removeForm || !removeSubmitButton) return;

    removeForm.addEventListener("submit", function (e) {
      e.preventDefault();

      confirmWithdrawalAccountRemoval().then(function (confirmed) {
        if (!confirmed) return;

        setButtonLoading(removeSubmitButton, true);

        var formData = new FormData(removeForm);
        var data = Object.fromEntries(formData);

        axios
          .post(removeForm.action, data)
          .then(function (response) {
            setButtonLoading(removeSubmitButton, false);

            showAlert({
              text: response.data.message || "Withdrawal bank account removed successfully.",
              icon: "success",
            }).then(function () {
              window.location.href =
                response.data.redirectUrl ||
                "/employer/billing?removed=withdrawal-account#withdrawal-account";
            });
          })
          .catch(function (error) {
            setButtonLoading(removeSubmitButton, false);

            showAlert({
              text: getErrorMessage(error, "Unable to remove withdrawal bank account."),
              icon: "error",
            });
          });
      });
    });
  }

  function handleWalletWithdrawalSubmission() {
    walletWithdrawalForm = document.querySelector("#kt_wallet_withdrawal_form");
    walletWithdrawalSubmitButton = document.querySelector("#kt_wallet_withdrawal_submit");

    if (!walletWithdrawalForm || !walletWithdrawalSubmitButton) return;

    var amountInput = document.querySelector("#wallet_withdrawal_amount");

    if (amountInput) {
      amountInput.addEventListener("input", function () {
        amountInput.value = amountInput.value.replace(/[^\d.,]/g, "");
      });
    }

    walletWithdrawalForm.addEventListener("submit", function (e) {
      e.preventDefault();

      var amountValue = amountInput?.value?.replace(/,/g, "").trim() || "";
      var amount = Number(amountValue);

      if (!amountValue || !Number.isFinite(amount) || amount <= 0) {
        showAlert({
          text: "Enter a valid withdrawal amount.",
          icon: "warning",
        });

        return;
      }

      confirmWalletWithdrawal().then(function (confirmed) {
        if (!confirmed) return;

        setButtonLoading(walletWithdrawalSubmitButton, true);

        var formData = new FormData(walletWithdrawalForm);
        var data = Object.fromEntries(formData);

        axios
          .post(walletWithdrawalForm.action, data)
          .then(function (response) {
            setButtonLoading(walletWithdrawalSubmitButton, false);

            showAlert({
              text: response.data.message || "Withdrawal request submitted successfully.",
              icon: "success",
            }).then(function () {
              window.location.href =
                response.data.redirectUrl ||
                "/employer/billing?submitted=withdrawal#withdrawal-status";
            });
          })
          .catch(function (error) {
            setButtonLoading(walletWithdrawalSubmitButton, false);

            showAlert({
              text: getErrorMessage(error, "Unable to submit withdrawal request."),
              icon: "error",
            }).then(function () {
              if (redirectUrl) {
                window.location.href = redirectUrl;
              }
            });
          });
      });
    });
  }

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

  return {
    init: function () {
      handleDVASetupSubmission();
      handleWithdrawalAccountResolution();
      handleWithdrawalAccountSubmission();
      handleWithdrawalAccountRemoval();
      handleWalletWithdrawalSubmission();
      handleCopyTextButtons();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerBilling.init();
});
