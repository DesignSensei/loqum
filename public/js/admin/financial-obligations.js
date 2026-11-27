(function () {
  "use strict";

  function initialize() {
    const root = document.getElementById("adminFinancialObligationDetails");
    if (!root) return;

    const feedback = document.getElementById("financialActionFeedback");
    const forms = [...root.querySelectorAll("form[data-financial-action]")];

    let busy = false;
    let refreshRequired = false;

    function validate(form) {
      const confirmation = form.querySelector("[data-confirmation]");

      form.querySelector('button[type="submit"]').disabled =
        busy ||
        refreshRequired ||
        !form.checkValidity() ||
        Boolean(confirmation &&
          confirmation.value !== confirmation.dataset.confirmation);
    }

    function validateAll() {
      forms.forEach(validate);
    }

    function message(text, error = false) {
      feedback.textContent = text;
      feedback.className = "alert mb-6 " +
        (error ? "alert-danger" : "alert-info");
      feedback.scrollIntoView({ block: "nearest" });
    }

    function clearOtp() {
      root.querySelectorAll('input[name="otp"]').forEach(input => {
        input.value = "";
      });
    }

    forms.forEach(form => {
      form.addEventListener("input", () => validate(form));

      form.addEventListener("submit", async event => {
        event.preventDefault();

        if (busy || refreshRequired) return;

        validate(form);

        if (form.querySelector('button[type="submit"]').disabled) return;

        const url = new URL(form.action, window.location.origin);

        if (url.origin !== window.location.origin ||
            !/^\/admin\/financial-obligations\/[a-f0-9]{24}\/(refund|reconcile|recover-refund|payout|reconcile-payout|retry-payout|payout-otp)$/i.test(url.pathname)) {
          message("Invalid financial action.", true);
          return;
        }

        const body = {};

        for (const name of ["reason", "refundId", "confirmation", "otp"]) {
          const control = form.elements.namedItem(name);

          if (control) {
            body[name] = name === "otp" ? control.value : control.value.trim();
          }
        }

        busy = true;
        clearOtp();
        validateAll();

        message("Verifying financial action...");

        try {
          const response = await fetch(url.toString(), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": root.dataset.csrfToken,
            },
            body: JSON.stringify(body),
          });

          if (!(response.headers.get("content-type") || "").includes("application/json")) {
            throw new Error("Unexpected server response.");
          }

          const result = await response.json();

          if (!response.ok || result.success !== true) {
            throw new Error(result.message || "Financial action could not be confirmed.");
          }

          refreshRequired = true;
          message("Request completed. Reloading obligation.");
          window.location.reload();

        } catch (error) {
          refreshRequired = true;

          message(
            error.message +
            " Refresh the obligation before performing another financial action.",
            true
          );

          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn btn-sm btn-light-primary ms-3";
          button.textContent = "Refresh Obligation";
          button.addEventListener("click", () => window.location.reload());

          feedback.appendChild(button);

        } finally {
          busy = false;
          clearOtp();
          validateAll();
        }
      });
    });

    validateAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
