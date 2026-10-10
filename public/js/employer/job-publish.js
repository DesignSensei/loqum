// public/js/employer/job-publish.js

"use strict";

var EmployerJobPublish = (function () {
  function initialize() {
    var controls = document.getElementById("job-publication-controls");
    if (!controls || controls.dataset.initialized === "true") {
      return;
    }

    var feedback = document.getElementById("job-publish-feedback");
    var csrf = document.getElementById("job-publication-csrf").value;
    var data;
    var busy = false;
    var locked = false;
    var paymentAttempt = null;
    var storageKey = "loqum-job-posting-purchase:" + controls.dataset.businessId;
    var purchaseForm = document.getElementById("job-publication-purchase-form");
    var publishForm = document.getElementById("job-confirm-publication-form");

    function message(text, kind, reviewLink) {
      feedback.replaceChildren(document.createTextNode(text));
      feedback.className = "alert alert-" + kind + " mb-0";
      feedback.hidden = false;
      if (reviewLink && data) {
        var link = document.createElement("a");
        link.href = data.actions.reviewUrl;
        link.className = "ms-3 fw-bold";
        link.textContent = "Refresh review";
        feedback.appendChild(link);
      }
      feedback.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function setBusy(value) {
      busy = value;
      controls.querySelectorAll("button, select").forEach(function (element) {
        element.disabled = busy || locked;
      });
      controls.setAttribute("aria-busy", String(busy));
    }

    async function post(url, payload) {
      var response = await axios.post(
        url,
        { ...payload, _csrf: csrf },
        {
          headers: { Accept: "application/json", "CSRF-Token": csrf },
          validateStatus: function () {
            return true;
          },
        }
      );
      if (response.status < 200 || response.status >= 300 || response.data?.success !== true) {
        var error = new Error(
          response.data?.message ||
            "The result could not be confirmed. Check the current status before trying again."
        );
        error.status = response.status;
        error.code = response.data?.code;
        throw error;
      }
      return response.data;
    }

    function clearAttempt() {
      localStorage.removeItem(storageKey);
      paymentAttempt = null;
    }

    async function verifyPayment(id) {
      if (busy) {
        return;
      }
      setBusy(true);
      try {
        var result = await post(data.actions.verifyUrl, { paymentId: id });
        if (result.data.paymentStatus === "paid") {
          clearAttempt();
          locked = true;
          message(
            "Payment verified. Refresh the review to confirm publication. No further payment is needed for this purchase.",
            "success",
            true
          );
        } else if (["failed", "cancelled", "refunded"].includes(result.data.paymentStatus)) {
          clearAttempt();
          locked = true;
          message(
            "Payment status: " +
              result.data.paymentStatus +
              ". Refresh the review before choosing the next action.",
            "warning",
            true
          );
        } else {
          message(
            "Payment is still pending. Continue the existing checkout or check again shortly; do not start another payment.",
            "info",
            true
          );
        }
      } catch (error) {
        message(
          error.message || "Payment verification is unavailable. Check again before paying.",
          "warning",
          true
        );
      } finally {
        setBusy(false);
      }
    }

    function openCheckout(accessCode, id) {
      if (typeof PaystackPop === "undefined" || !accessCode) {
        message(
          "Checkout is not available yet. Refresh this page and continue the existing payment.",
          "warning",
          true
        );
        setBusy(false);
        return;
      }
      setBusy(true);
      try {
        var popup = new PaystackPop();
        popup.resumeTransaction(accessCode, {
          onSuccess: function () {
            // A browser callback is not proof of payment. The server verifies it.
            setBusy(false);
            verifyPayment(id);
          },
          onCancel: function () {
            setBusy(false);
            message(
              "Checkout closed. Your payment may still be pending. Refresh to continue or check that purchase.",
              "info",
              true
            );
          },
          onError: function () {
            setBusy(false);
            message(
              "Checkout could not open. Refresh to continue or check the existing payment.",
              "warning",
              true
            );
          },
        });
      } catch (error) {
        setBusy(false);
        message("Checkout could not open. Refresh to check the existing payment.", "warning", true);
      }
    }

    try {
      data = JSON.parse(document.getElementById("job-publication-data").value);
      if (typeof axios === "undefined" || !csrf) {
        throw new Error("The page could not initialize. Reload before publishing or paying.");
      }
      if (purchaseForm) {
        paymentAttempt = JSON.parse(localStorage.getItem(storageKey) || "null");
      }
    } catch (error) {
      message(
        "The page could not initialize. Allow browser storage and reload before paying or publishing.",
        "danger",
        false
      );
      return;
    }

    if (publishForm) {
      publishForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (busy || locked) {
          return;
        }
        setBusy(true);
        try {
          await post(data.actions.confirmUrl, { review: data.review });
          locked = true;
          window.location.assign(data.actions.detailsUrl);
        } catch (error) {
          // Reload rather than repeating a command whose result may be uncertain.
          locked = true;
          message(error.message, "warning", true);
        } finally {
          setBusy(false);
        }
      });
    }

    if (purchaseForm) {
      purchaseForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (busy || locked) {
          return;
        }
        var plan = document.getElementById("publication-plan");
        var option = plan.selectedOptions[0];
        var method = document.getElementById("publication-payment-method").value;
        setBusy(true);
        try {
          paymentAttempt = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (
            paymentAttempt &&
            (paymentAttempt.planId !== plan.value || paymentAttempt.method !== method)
          ) {
            throw new Error(
              "A previous purchase attempt is unresolved. Use its original product and payment method, or check Billing before buying another."
            );
          }
          if (!paymentAttempt) {
            paymentAttempt = {
              planId: plan.value,
              method: method,
              key: "job-posting-" + crypto.randomUUID(),
            };
          }
          localStorage.setItem(storageKey, JSON.stringify(paymentAttempt));
          var result = await post(
            method === "wallet" ? data.actions.walletUrl : data.actions.checkoutUrl,
            {
              planId: plan.value,
              idempotencyKey: paymentAttempt.key,
              expectedPriceMinor: Number(option.dataset.price),
              expectedCurrency: option.dataset.currency,
            }
          );
          if (result.data?.payment?.paymentStatus === "paid") {
            clearAttempt();
            locked = true;
            message(
              "Payment completed. Refresh the review to confirm publication.",
              "success",
              true
            );
          } else if (method === "paystack_checkout") {
            openCheckout(result.data?.checkout?.accessCode, result.data?.payment?._id);
            return;
          } else {
            message(
              "The purchase is unresolved. Refresh and check its status before paying again.",
              "warning",
              true
            );
          }
        } catch (error) {
          if (
            [
              "JOB_PAYMENT_ATTEMPT_CLOSED",
              "JOB_PAYMENT_ALREADY_REFUNDED",
              "JOB_POSTING_PRICE_CHANGED",
              "JOB_POSTING_PLAN_NOT_ACTIVE",
            ].includes(error.code)
          ) {
            clearAttempt();
            locked = true;
          }
          message(
            error.message ||
              "The purchase result is unknown. Retry only the same purchase, or check Billing.",
            "warning",
            true
          );
        }
        setBusy(false);
      });
    }

    controls.querySelectorAll("[data-verify-payment]").forEach(function (button) {
      button.addEventListener("click", function () {
        verifyPayment(button.dataset.verifyPayment);
      });
    });
    controls.querySelectorAll("[data-resume-payment]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (busy || locked) {
          return;
        }
        var payment = data.pendingPayments.find(function (item) {
          return item.id === button.dataset.resumePayment;
        });
        if (payment) {
          openCheckout(payment.accessCode, payment.id);
        }
      });
    });

    if (window.FormControls) {
      FormControls.init(controls, { selects: "select" });
    }

    controls.dataset.initialized = "true";
    setBusy(false);
  }

  return { init: initialize };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerJobPublish.init();
});
