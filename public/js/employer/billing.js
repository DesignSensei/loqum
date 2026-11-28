// public/js/employer/billing.js

"use strict";

var EmployerBilling = (function () {
  var dvaSetupForm = null;
  var dvaSetupSubmitButton = null;

  var withdrawalAccountForm = null;
  var withdrawalAccountSubmitButton = null;

  var walletWithdrawalForm = null;
  var walletWithdrawalSubmitButton = null;

  var subscriptionPlanChangeForm = null;
  var subscriptionPlanChangeTargetSlots = null;
  var subscriptionPlanChangeRequiresSelection = false;

  function getErrorMessage(error, fallbackMessage) {
    return error?.response?.data?.message || error?.message || fallbackMessage;
  }

  function getErrorRedirectUrl(error) {
    return error?.response?.data?.redirectUrl || null;
  }

  function getCheckoutAuthorizationUrl(response) {
    return (
      response?.data?.checkout?.authorizationUrl ||
      response?.data?.authorizationUrl ||
      response?.data?.data?.checkout?.authorizationUrl ||
      response?.data?.data?.authorizationUrl ||
      null
    );
  }

  function getSubscriptionPaymentResult(response) {
    return response?.data?.data || {};
  }

  function isPaymentCompleted(response) {
    var result = getSubscriptionPaymentResult(response);
    var status = result.payment?.paymentStatus || null;

    if (["failed", "cancelled", "refunded"].includes(status)) {
      return false;
    }

    return (
      result.paid === true ||
      result.alreadyPaid === true ||
      status === "paid"
    );
  }

  function getSubscriptionPaymentAlert(response, fallbackMessage) {
    var result = getSubscriptionPaymentResult(response);
    var payment = result.payment || {};
    var application = result.application || {};

    if (!isPaymentCompleted(response)) {
      return {
        text:
          "Payment remains unresolved. Check its status before starting another purchase.",
        icon: "warning",
      };
    }

    if (result.applicationError) {
      return {
        text:
          "Payment completed, but the subscription update is pending. Do not pay again for this purchase.",
        icon: "info",
      };
    }

    if (
      result.applied === true ||
      application.applied === true ||
      Boolean(payment.appliedAt)
    ) {
      return {
        text: fallbackMessage || "Payment completed and subscription updated.",
        icon: "success",
      };
    }

    if (
      payment.paymentKind === "renewal" &&
      application.reason === "billing_period_not_started"
    ) {
      return {
        text:
          "Renewal payment completed. It will take effect when the current billing period ends.",
        icon: "success",
      };
    }

    return {
      text:
        "Payment completed. Your subscription update is still being processed. Do not pay again.",
      icon: "info",
    };
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
    if (!window.Swal) {
      window.alert(text);
      return Promise.resolve();
    }

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

  function createIdempotencyKey(prefix) {
    if (window.crypto?.randomUUID) {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function ensureIdempotencyKey(form, prefix) {
    var input = form?.querySelector('input[name="idempotencyKey"]');

    if (!input) return null;

    if (!input.value.trim()) {
      input.value = createIdempotencyKey(prefix);
    }

    return input.value;
  }

  function clearIdempotencyKey(form) {
    var input = form?.querySelector('input[name="idempotencyKey"]');

    if (input) {
      input.value = "";
    }
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
            var redirectUrl = getErrorRedirectUrl(error);

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

  async function submitSubscriptionPaymentForm({
    form,
    submitButton,
    idempotencyPrefix,
    successMessage,
  }) {
    var paymentFlow = form?.dataset?.paymentFlow || "wallet";

    if (!form || !submitButton || submitButton.disabled) return;

    var confirmedPrice = form.dataset.confirmPrice;

    if (!confirmedPrice) {
      showAlert({
        text: "Purchase price is unavailable. Refresh the billing page.",
        icon: "warning",
      });
      return;
    }

    setButtonLoading(submitButton, true);

    var message =
      "Confirm subscription payment of " +
      confirmedPrice +
      (paymentFlow === "checkout"
        ? " through Paystack?"
        : " from your employer wallet?");

    var confirmed;

    try {
      if (window.Swal) {
        var result = await Swal.fire({
          text: message,
          icon: "question",
          showCancelButton: true,
          confirmButtonText: "Confirm payment",
          cancelButtonText: "Cancel",
          buttonsStyling: false,
          customClass: {
            confirmButton: "btn btn-primary",
            cancelButton: "btn btn-light",
          },
        });

        confirmed = result.isConfirmed;
      } else {
        confirmed = window.confirm(message);
      }
    } catch (error) {
      setButtonLoading(submitButton, false);

      showAlert({
        text: "Payment confirmation could not be completed.",
        icon: "error",
      });

      return;
    }

    if (!confirmed) {
      setButtonLoading(submitButton, false);
      return;
    }


    ensureIdempotencyKey(form, idempotencyPrefix);
    setButtonLoading(submitButton, true);

    var formData = new FormData(form);
    var data = Object.fromEntries(formData);

    axios
      .post(form.action, data)
      .then(function (response) {
        if (paymentFlow === "checkout") {
          var authorizationUrl = getCheckoutAuthorizationUrl(response);

          if (authorizationUrl) {
            window.location.href = authorizationUrl;
            return;
          }

          if (isPaymentCompleted(response)) {
            setButtonLoading(submitButton, false);

            var alertConfig = getSubscriptionPaymentAlert(response, "Payment completed.");

            showAlert(alertConfig).then(function () {
              window.location.href = response.data.redirectUrl || "/employer/billing#subscription";
            });

            return;
          }

          throw new Error(
            "Payment status could not be confirmed. Please retry or check your billing page."
          );
        }

        setButtonLoading(submitButton, false);

        var alertConfig = getSubscriptionPaymentAlert(response, successMessage);

        showAlert(alertConfig).then(function () {
          window.location.href = response.data.redirectUrl || "/employer/billing#subscription";
        });
      })
      .catch(function (error) {
        var redirectUrl = getErrorRedirectUrl(error);

        setButtonLoading(submitButton, false);

        showAlert({
          text: getErrorMessage(error, "Unable to complete the subscription payment."),
          icon: "error",
        }).then(function () {
          if (redirectUrl) {
            window.location.href = redirectUrl;
          }
        });
      });
  }

  function handleSubscriptionPurchaseSubmission() {
    var forms = document.querySelectorAll(".js-subscription-purchase-form");

    forms.forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();

        var submitButton = form.querySelector('button[type="submit"]');

        if (!submitButton || submitButton.disabled) return;

        submitSubscriptionPaymentForm({
          form,
          submitButton,
          idempotencyPrefix: "subscription-initial",
          successMessage: "Subscription purchased successfully.",
        });
      });
    });
  }

  function handleSubscriptionRenewalSubmission() {
    var forms = document.querySelectorAll(".js-subscription-renewal-form");

    forms.forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();

        var submitButton = form.querySelector('button[type="submit"]');

        if (!submitButton || submitButton.disabled) return;

        submitSubscriptionPaymentForm({
          form,
          submitButton,
          idempotencyPrefix: "subscription-renewal",
          successMessage: "Subscription renewal payment completed successfully.",
        });
      });
    });
  }

  function confirmSubscriptionCancellation() {
    var message =
      "Cancel this subscription at the end of the current paid period? Benefits remain active until then.";

    if (!window.Swal) {
      return Promise.resolve(window.confirm(message));
    }

    return Swal.fire({
      text: message,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, cancel at period end",
      cancelButtonText: "Keep subscription",
      buttonsStyling: false,
      customClass: {
        confirmButton: "btn btn-danger",
        cancelButton: "btn btn-light",
      },
    }).then(function (result) {
      return result.isConfirmed;
    });
  }

  function handleSubscriptionAutomaticRenewal() {
    var form = document.querySelector(
      "#kt_subscription_automatic_renewal_form"
    );

    if (!form) return;

    var submitButton = form.querySelector(
      'button[type="submit"]'
    );

    if (!submitButton) return;

    var busy = false;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (busy) return;

      busy = true;

      setButtonLoading(submitButton, true);

      try {
        var data = Object.fromEntries(
          new FormData(form)
        );

        var enabling =
          data.enabled === "true";

        var message = enabling
          ? "Authorize LOQUM to deduct " +
            form.dataset.renewalPrice +
            " from your wallet for each " +
            form.dataset.billingCycle.toLowerCase() +
            " subscription renewal. Payment may be collected " +
            "within 24 hours before expiry. " +
            "You can disable automatic renewal at any time."
          : "Disable automatic renewal? Your existing paid benefits " +
            "will remain unchanged. No new automatic deductions " +
            "will be initiated after this preference is saved.";

        var confirmed;

        if (window.Swal) {
          var result = await Swal.fire({
            title: enabling
              ? "Enable automatic renewal?"
              : "Disable automatic renewal?",

            text: message,

            icon: "question",

            showCancelButton: true,

            confirmButtonText: enabling
              ? "Enable automatic renewal"
              : "Disable automatic renewal",

            cancelButtonText:
              "Cancel",

            buttonsStyling: false,

            customClass: {
              confirmButton: "btn btn-primary",
              cancelButton: "btn btn-light",
            },
          });

          confirmed = result.isConfirmed;
        } else {
          confirmed = window.confirm(message);
        }

        if (!confirmed) return;

        var response = await axios.post(
          form.action,
          data
        );

        await showAlert({
          text:
            response.data.message ||
            "Automatic renewal preference updated.",

          icon: "success",
        });

        window.location.reload();
      } catch (error) {
        await showAlert({
          text: getErrorMessage(
            error,
            "Unable to update automatic renewal."
          ),

          icon: "error",
        });
      } finally {
        busy = false;

        setButtonLoading(submitButton, false);
      }
    });
  }

  function handleSubscriptionCancellation() {
    var form = document.querySelector("#kt_subscription_cancel_form");
    var submitButton = document.querySelector("#kt_subscription_cancel_submit");

    if (!form || !submitButton) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      confirmSubscriptionCancellation().then(function (confirmed) {
        if (!confirmed) return;

        setButtonLoading(submitButton, true);

        var formData = new FormData(form);
        var data = Object.fromEntries(formData);

        axios
          .post(form.action, data)
          .then(function (response) {
            setButtonLoading(submitButton, false);

            showAlert({
              text: response.data.message || "Subscription cancellation scheduled successfully.",
              icon: "success",
            }).then(function () {
              window.location.href = response.data.redirectUrl || "/employer/billing#subscription";
            });
          })
          .catch(function (error) {
            var redirectUrl = getErrorRedirectUrl(error);

            setButtonLoading(submitButton, false);

            showAlert({
              text: getErrorMessage(error, "Unable to schedule subscription cancellation."),
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

  function getPlanChangeCheckboxes() {
    if (!subscriptionPlanChangeForm) return [];

    return Array.from(subscriptionPlanChangeForm.querySelectorAll(".js-retained-publication"));
  }

  function getSelectedPlanChangePublicationIds() {
    return getPlanChangeCheckboxes()
      .filter(function (checkbox) {
        return checkbox.checked;
      })
      .map(function (checkbox) {
        return checkbox.value;
      });
  }

  function setPlanChangeSubmitButtonsDisabled(disabled) {
    if (!subscriptionPlanChangeForm) return;

    subscriptionPlanChangeForm
      .querySelectorAll(".js-subscription-plan-change-submit")
      .forEach(function (button) {
        if (!button.hasAttribute("data-kt-indicator")) {
          button.disabled = disabled;
        }
      });
  }

  function updatePlanChangeSelectionState() {
    if (!subscriptionPlanChangeForm) return;

    var checkboxes = getPlanChangeCheckboxes();
    var selectedIds = getSelectedPlanChangePublicationIds();
    var selectionCount = document.querySelector("#subscription_plan_change_selection_count");

    if (!subscriptionPlanChangeRequiresSelection) {
      checkboxes.forEach(function (checkbox) {
        checkbox.disabled = false;
      });

      if (selectionCount) {
        selectionCount.textContent = "";
      }

      setPlanChangeSubmitButtonsDisabled(false);
      return;
    }

    var requiredCount = Math.max(Number(subscriptionPlanChangeTargetSlots) || 0, 0);
    var selectionComplete = selectedIds.length === requiredCount;

    checkboxes.forEach(function (checkbox) {
      checkbox.disabled = !checkbox.checked && selectedIds.length >= requiredCount;
    });

    if (selectionCount) {
      selectionCount.textContent = `${selectedIds.length} of ${requiredCount} selected.`;
    }

    setPlanChangeSubmitButtonsDisabled(!selectionComplete);
  }

  function resetPlanChangeSelection(clearPaymentAttempt) {
    getPlanChangeCheckboxes().forEach(function (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = false;
    });

    subscriptionPlanChangeTargetSlots = null;
    subscriptionPlanChangeRequiresSelection = false;

    if (clearPaymentAttempt) {
      clearIdempotencyKey(subscriptionPlanChangeForm);
    }

    updatePlanChangeSelectionState();
  }

  function configurePlanChangeModal(triggerButton) {
    if (!subscriptionPlanChangeForm) return;

    var subscriptionCard = document.querySelector("#subscription");
    var planIdInput = document.querySelector("#subscription_plan_change_plan_id");
    var planName = document.querySelector("#subscription_plan_change_name");
    var planPrice = document.querySelector("#subscription_plan_change_price");
    var retentionContainer = document.querySelector("#subscription_plan_change_retention");
    var retentionHelp = document.querySelector("#subscription_plan_change_retention_help");
    var allEndNotice = document.querySelector("#subscription_plan_change_all_end");

    var occupiedSlots = Math.max(Number(subscriptionCard?.dataset?.occupiedJobSlots) || 0, 0);
    var targetSlots = Math.max(Number(triggerButton.dataset.activeJobSlots) || 0, 0);

    resetPlanChangeSelection(true);

    subscriptionPlanChangeTargetSlots = targetSlots;
    subscriptionPlanChangeRequiresSelection = occupiedSlots > targetSlots && targetSlots > 0;

    if (planIdInput) {
      planIdInput.value = triggerButton.dataset.planId || "";
    }

    subscriptionPlanChangeForm.elements.namedItem(
      "expectedPriceMinor"
    ).value = triggerButton.dataset.planPriceMinor || "";

    subscriptionPlanChangeForm.elements.namedItem(
      "expectedCurrency"
    ).value = triggerButton.dataset.planCurrency || "";

    subscriptionPlanChangeForm.elements.namedItem(
      "expectedPlanId"
    ).value = triggerButton.dataset.planId || "";

    if (planName) {
      planName.textContent = triggerButton.dataset.planName || "Selected plan";
    }

    if (planPrice) {
      planPrice.textContent = triggerButton.dataset.planPrice || "";
    }

    if (retentionContainer) {
      retentionContainer.classList.toggle("d-none", !subscriptionPlanChangeRequiresSelection);
    }

    if (retentionHelp) {
      retentionHelp.textContent = subscriptionPlanChangeRequiresSelection
        ? `Your current ${occupiedSlots} active subscription publications exceed this plan's ${targetSlots} slots. Select exactly ${targetSlots} publication${
            targetSlots === 1 ? "" : "s"
          } to keep active.`
        : "";
    }

    if (allEndNotice) {
      allEndNotice.classList.toggle("d-none", !(occupiedSlots > 0 && targetSlots === 0));
    }

    updatePlanChangeSelectionState();
  }

  function submitSubscriptionPlanChange(paymentFlow, submitButton) {
    if (!subscriptionPlanChangeForm) return;

    var planIdInput = document.querySelector("#subscription_plan_change_plan_id");
    var planId = planIdInput?.value?.trim() || "";

    if (!planId) {
      showAlert({
        text: "Select a subscription plan before continuing.",
        icon: "warning",
      });

      return;
    }

    var retainedPublicationIds = getSelectedPlanChangePublicationIds();

    if (
      subscriptionPlanChangeRequiresSelection &&
      retainedPublicationIds.length !== subscriptionPlanChangeTargetSlots
    ) {
      showAlert({
        text: `Select exactly ${subscriptionPlanChangeTargetSlots} active Job publication${
          subscriptionPlanChangeTargetSlots === 1 ? "" : "s"
        } to retain.`,
        icon: "warning",
      });

      return;
    }

    ensureIdempotencyKey(subscriptionPlanChangeForm, "subscription-plan-change");

    setButtonLoading(submitButton, true);

    subscriptionPlanChangeForm
      .querySelectorAll(".js-subscription-plan-change-submit")
      .forEach(function (button) {
        if (button !== submitButton) {
          button.disabled = true;
        }
      });

    var formData = new FormData(subscriptionPlanChangeForm);
    var data = Object.fromEntries(formData);

    if (subscriptionPlanChangeRequiresSelection) {
      data.retainedPublicationIds = retainedPublicationIds;
    } else {
      delete data.retainedPublicationIds;
    }

    var action =
      paymentFlow === "checkout"
        ? subscriptionPlanChangeForm.dataset.checkoutAction
        : subscriptionPlanChangeForm.dataset.walletAction;

    if (!action) {
      setButtonLoading(submitButton, false);
      updatePlanChangeSelectionState();

      showAlert({
        text: "The selected plan-change payment route is unavailable.",
        icon: "error",
      });

      return;
    }

    axios
      .post(action, data)
      .then(function (response) {
        if (paymentFlow === "checkout") {
          var authorizationUrl = getCheckoutAuthorizationUrl(response);

          if (authorizationUrl) {
            window.location.href = authorizationUrl;
            return;
          }

          if (isPaymentCompleted(response)) {
            setButtonLoading(submitButton, false);

            showAlert(
              getSubscriptionPaymentAlert(
                response,
                "Subscription plan changed successfully."
              )
            ).then(function () {
              window.location.href = response.data.redirectUrl || "/employer/billing#subscription";
            });

            return;
          }

          throw new Error(
            "Payment status could not be confirmed. Please retry or check your billing page."
          );
        }

        setButtonLoading(submitButton, false);

        var alertConfig = getSubscriptionPaymentAlert(
          response,
          "Subscription plan changed successfully."
        );

        showAlert(alertConfig).then(function () {
          window.location.href = response.data.redirectUrl || "/employer/billing#subscription";
        });
      })
      .catch(function (error) {
        var redirectUrl = getErrorRedirectUrl(error);

        setButtonLoading(submitButton, false);
        updatePlanChangeSelectionState();

        showAlert({
          text: getErrorMessage(error, "Unable to change the subscription plan."),
          icon: "error",
        }).then(function () {
          if (redirectUrl) {
            window.location.href = redirectUrl;
          }
        });
      });
  }

  function handleSubscriptionPlanChange() {
    subscriptionPlanChangeForm = document.querySelector("#kt_subscription_plan_change_form");

    if (!subscriptionPlanChangeForm) return;

    document.querySelectorAll(".js-subscription-plan-change").forEach(function (button) {
      button.addEventListener("click", function () {
        configurePlanChangeModal(button);
      });
    });

    getPlanChangeCheckboxes().forEach(function (checkbox) {
      checkbox.addEventListener("change", function () {
        updatePlanChangeSelectionState();
      });
    });

    subscriptionPlanChangeForm
      .querySelectorAll(".js-subscription-plan-change-submit")
      .forEach(function (button) {
        button.addEventListener("click", function () {
          if (button.disabled) return;

          submitSubscriptionPlanChange(button.dataset.paymentFlow || "wallet", button);
        });
      });

    var modal = document.querySelector("#kt_subscription_plan_change_modal");

    if (modal) {
      modal.addEventListener("hidden.bs.modal", function () {
        resetPlanChangeSelection(false);
      });
    }
  }

  function handleSubscriptionPaymentRecovery() {
    document
      .querySelectorAll(".js-subscription-payment-verify-form")
      .forEach(function (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();

          var button = form.querySelector('button[type="submit"]');

          if (!button || button.disabled) return;

          setButtonLoading(button, true);

          var data = Object.fromEntries(new FormData(form));

          axios
            .post(form.action, data)
            .then(function (response) {
              var result = getSubscriptionPaymentResult(response);
              var status = result.payment?.paymentStatus;

              var alertConfig;

              if (["failed", "cancelled", "refunded"].includes(status)) {
                alertConfig = {
                  text:
                    response.data.message ||
                    "Payment status updated.",
                  icon: "info",
                };
              } else {
                alertConfig = getSubscriptionPaymentAlert(
                  response,
                  "Payment verified and subscription updated."
                );
              }

              // Keep the action disabled until the display is refreshed.
              return showAlert(alertConfig).then(function () {
                window.location.hash = "subscription-payments";
                window.location.reload();
              });
            })
            .catch(function (error) {
              setButtonLoading(button, false);

              showAlert({
                text: getErrorMessage(
                  error,
                  "Unable to confirm the payment status. Do not make another payment until this attempt is resolved."
                ),
                icon: "warning",
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
      handleSubscriptionPurchaseSubmission();
      handleSubscriptionRenewalSubmission();
      handleSubscriptionAutomaticRenewal();
      handleSubscriptionCancellation();
      handleSubscriptionPlanChange();
      handleSubscriptionPaymentRecovery();
      handleCopyTextButtons();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerBilling.init();
});
