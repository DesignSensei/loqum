// public/js/onboarding/onboarding-professional.js

"use strict";

var OnboardingProfessional = (function () {
  var form = document.querySelector("#kt_onboarding_professional_form");
  var submitButton = document.querySelector("#kt_onboarding_professional_submit");

  var ninInput = document.querySelector("#ninInput");
  var ninConsent = document.querySelector("#ninConsent");
  var ninVerifyButton = document.querySelector("#kt_onboarding_nin_verify");
  var ninResult = document.querySelector("#ninVerificationResult");
  var ninMessage = document.querySelector("#ninVerificationMessage");

  var validator = null;

  var ninRequestInProgress = false;
  var formValidationInProgress = false;
  var formSubmissionInProgress = false;
  var onboardingCommitted = false;

  var ninState = "unconfirmed";
  var currentNINResult = null;

  // ───────────────────── NIN RATE LIMIT ─────────────────────

  /*
   * The backend enforces:
   *
   * - 8 total lookups within a rolling 24-hour period;
   * - 4 distinct NINs within the same period;
   * - No mandatory cooldown between completed lookups;
   * - Reuse of eligible cached results;
   * - One active provider lookup per account;
   * - Blocking of unresolved provider outcomes.
   *
   * The frontend displays the backend's rate-limit
   * response but never independently authorizes
   * or rejects a potentially chargeable lookup.
   *
   * A total limit prevents new paid lookups,
   * but eligible cached results may still be reusable.
   *
   * A distinct limit prevents checking a fifth NIN,
   * but previously attempted NINs may still qualify.
   *
   * The browser does not retain NIN attempt history.
   * The backend is the final authority.
   *
   * There are no automatic paid retries.
   */

  var ninRateLimitedUntil = null;
  var ninRateLimitTimer = null;

  // ───────────────────── NAME CONFIRMATION CONTROLS ─────────────────────

  var namePanel = null;
  var nameText = null;
  var nameHelp = null;
  var acknowledgeButton = null;
  var changeNINButton = null;

  // ───────────────────── PROFESSION CONFIGURATION ─────────────────────

  /*
   * Registration body per profession.
   *
   * When scaling, enable the corresponding
   * profession configuration and EJS fields.
   */

  var typeConfig = {
    pharmacist: {
      fieldId: "field-pharmacist",
      validatorMessage: "PCN licence number is required.",
    },

    // pharmacy_technician: {
    //   fieldId: "field-pharmacy_technician",
    //   validatorMessage: "PCN licence number is required.",
    // },

    // nurse: {
    //   fieldId: "field-nurse",
    //   validatorMessage: "NMCN licence number is required.",
    // },

    // doctor: {
    //   fieldId: "field-doctor",
    //   validatorMessage: "MDCN licence number is required.",
    // },

    // lab_scientist: {
    //   fieldId: "field-lab_scientist",
    //   validatorMessage: "MLSCN licence number is required.",
    // },

    // radiographer: {
    //   fieldId: "field-radiographer",
    //   validatorMessage: "RRBN licence number is required.",
    // },

    // physiotherapist: {
    //   fieldId: "field-physiotherapist",
    //   validatorMessage: "MRPN licence number is required.",
    // },
  };

  // ───────────────────── TYPE SWITCHING ─────────────────────

  function handleTypeSwitching() {
    var radios = document.querySelectorAll('input[name="type"]');

    if (!radios.length) {
      return;
    }

    function switchField(selectedType) {
      document.querySelectorAll(".licence-field").forEach(function (field) {
        field.style.display = "none";

        var input = field.querySelector("input");

        if (input) {
          input.disabled = true;
        }
      });

      var config = typeConfig[selectedType];

      if (!config) {
        return;
      }

      var activeField = document.getElementById(config.fieldId);

      if (activeField) {
        activeField.style.display = "block";

        var input = activeField.querySelector("input");

        if (input) {
          input.disabled = false;
        }
      }

      if (validator) {
        validator.updateFieldStatus("licenceNumber", "NotValidated");

        validator.updateValidatorOption(
          "licenceNumber",
          "notEmpty",
          "message",
          config.validatorMessage
        );
      }
    }

    var defaultRadio = document.querySelector('input[name="type"]:checked');

    if (defaultRadio) {
      switchField(defaultRadio.value);
    }

    radios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        switchField(this.value);
      });
    });
  }

  // ───────────────────── NIN RESULT DISPLAY ─────────────────────

  function clearNINResult() {
    if (!ninResult || !ninMessage) {
      return;
    }

    ninResult.classList.add("d-none");

    ninResult.classList.remove(
      "alert-success",
      "alert-warning",
      "alert-danger",
      "alert-info",
      "alert-light-success",
      "alert-light-warning",
      "alert-light-danger",
      "alert-light-info"
    );

    ninMessage.textContent = "";

    if (namePanel) {
      namePanel.classList.add("d-none");
    }
  }

  function showNINResult(message, type) {
    if (!ninResult || !ninMessage) {
      return;
    }

    clearNINResult();

    var alertClass = "alert-info";

    if (type === "success") {
      alertClass = "alert-success";
    } else if (type === "warning") {
      alertClass = "alert-warning";
    } else if (type === "danger") {
      alertClass = "alert-danger";
    }

    ninResult.classList.add(alertClass);
    ninResult.classList.remove("d-none");

    /*
     * Provider and server response text must
     * never be inserted using innerHTML.
     */

    ninMessage.textContent = String(message || "");
  }

  function getNINResultType(result) {
    if (!result || !result.status) {
      return "warning";
    }

    if (result.eligibleForOnboarding === true) {
      return "success";
    }

    if (result.status === "not_found") {
      return "danger";
    }

    return "warning";
  }

  // ───────────────────── NIN RATE-LIMIT HELPERS ─────────────────────

  /*
   * NIN verification limits:
   *
   * - 8 total lookups in rolling 24 hours;
   * - 4 distinct NINs in rolling 24 hours.
   *
   * The backend calculates nextEligibleAt from
   * durable lookup history.
   *
   * The timestamp applies to the rejected lookup.
   * It must not be interpreted as a blanket
   * prohibition on every possible cached result
   * or previously attempted NIN.
   */

  function hasActiveNINRateLimitNotice() {
    return Number.isFinite(ninRateLimitedUntil) && Date.now() < ninRateLimitedUntil;
  }

  function formatNINRetryTime(timestamp) {
    var date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    /*
     * Display the backend-issued timestamp in
     * the user's browser-local timezone.
     */

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function clearNINRateLimitTimer() {
    if (ninRateLimitTimer !== null) {
      window.clearTimeout(ninRateLimitTimer);
      ninRateLimitTimer = null;
    }
  }

  function clearNINRateLimitState() {
    clearNINRateLimitTimer();
    ninRateLimitedUntil = null;
  }

  function scheduleNINRateLimitRelease() {
    clearNINRateLimitTimer();

    if (!Number.isFinite(ninRateLimitedUntil)) {
      return;
    }

    var remaining = ninRateLimitedUntil - Date.now();

    if (remaining <= 0) {
      releaseNINRateLimit();
      return;
    }

    /*
     * The timer only updates the UI.
     *
     * It does not initiate another lookup.
     *
     * Background tabs may delay browser timers.
     * Focus and visibility events also check expiry.
     */

    var delay = Math.min(remaining, 2147483647);

    ninRateLimitTimer = window.setTimeout(function () {
      ninRateLimitTimer = null;
      releaseNINRateLimit();
    }, delay);
  }

  function releaseNINRateLimit() {
    if (!Number.isFinite(ninRateLimitedUntil)) {
      return;
    }

    if (Date.now() < ninRateLimitedUntil) {
      scheduleNINRateLimitRelease();
      return;
    }

    clearNINRateLimitState();

    if (ninState === "unconfirmed" && !ninRequestInProgress) {
      showNINResult(
        "The previously reported NIN lookup restriction has reached its retry time. You can request verification again, subject to the server's current limits.",
        "info"
      );
    }

    updateNINControls();
  }

  function handleNINRateLimit(error) {
    var response = error?.response;
    var data = response?.data;

    /*
     * Only the dedicated NIN rate-limit response
     * may establish a timed frontend notice.
     *
     * Generic 429 errors and unresolved provider
     * outcomes must not be assigned an invented
     * rolling-window expiry.
     */

    if (
      response?.status !== 429 ||
      !data ||
      data.code !== "NIN_ONBOARDING_RATE_LIMITED" ||
      typeof data.nextEligibleAt !== "string"
    ) {
      return false;
    }

    var nextEligibleAt = Date.parse(data.nextEligibleAt);

    if (!Number.isFinite(nextEligibleAt) || nextEligibleAt <= Date.now()) {
      return false;
    }

    var retryTime = formatNINRetryTime(nextEligibleAt);
    var message;

    if (data.limitType === "total") {
      message =
        "NIN verification limit reached. You have used all 8 lookup attempts allowed within a rolling 24-hour period. " +
        "Another paid lookup is not available until " +
        retryTime +
        ". An eligible cached result may still be reusable.";
    } else if (data.limitType === "distinct") {
      message =
        "NIN verification limit reached. You have attempted 4 different NINs within a rolling 24-hour period. " +
        "A fifth distinct NIN cannot be checked until " +
        retryTime +
        ". You may still retry a previously attempted NIN if your total lookup allowance permits.";
    } else if (data.limitType === "both") {
      message =
        "Both NIN lookup limits have been reached for the number submitted. " +
        "That new NIN is not eligible until " +
        retryTime +
        ". A previously attempted NIN may become eligible sooner when the total lookup allowance becomes available. " +
        "Eligible cached results may also be reused.";
    } else {
      return false;
    }

    /*
     * The timestamp describes eligibility
     * for the rejected lookup.
     *
     * It does not prove every other NIN is
     * ineligible until that exact time.
     */

    message += " The server checks eligibility before initiating another paid lookup.";

    message += " If you believe this restriction is incorrect, please contact Loqum Support.";

    ninRateLimitedUntil = nextEligibleAt;

    scheduleNINRateLimitRelease();

    showNINResult(message, "warning");

    /*
     * Keep Verify NIN available.
     *
     * The backend may authorize a cached result
     * or an eligible previously attempted NIN.
     *
     * No paid request may bypass backend limits.
     */

    updateNINControls();

    return true;
  }

  function handleNINRateLimitLifecycle() {
    /*
     * Inactive tabs can delay scheduled timers.
     *
     * Re-check expiry when the tab becomes active.
     */

    window.addEventListener("focus", function () {
      releaseNINRateLimit();
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        releaseNINRateLimit();
      }
    });
  }

  // ───────────────────── NIN LEGAL-NAME PREVIEW ─────────────────────

  /*
   * Create the legal-name preview inside
   * the existing NIN result panel.
   *
   * No additional EJS buttons are required.
   *
   * Registry names are inserted as text,
   * never as executable HTML.
   */

  function createNameControls() {
    if (!ninResult || namePanel) {
      return;
    }

    namePanel = document.createElement("div");
    namePanel.id = "ninRegistryNamePanel";
    namePanel.className = "mt-4 d-none";

    var title = document.createElement("div");
    title.className = "fw-semibold mb-2";
    title.textContent = "Legal name returned by the NIN registry";

    nameText = document.createElement("div");
    nameText.className = "fs-5 fw-bold mb-2";

    nameHelp = document.createElement("div");
    nameHelp.className = "fs-7 mb-3";

    var actions = document.createElement("div");
    actions.className = "d-flex flex-wrap gap-2";

    acknowledgeButton = document.createElement("button");
    acknowledgeButton.type = "button";
    acknowledgeButton.id = "kt_onboarding_nin_acknowledge_name";
    acknowledgeButton.className = "btn btn-sm btn-primary";
    acknowledgeButton.textContent = "Yes, this is my legal name";

    changeNINButton = document.createElement("button");
    changeNINButton.type = "button";
    changeNINButton.id = "kt_onboarding_nin_change_number";
    changeNINButton.className = "btn btn-sm btn-light";
    changeNINButton.textContent = "No, enter a different NIN";

    actions.appendChild(acknowledgeButton);
    actions.appendChild(changeNINButton);

    namePanel.appendChild(title);
    namePanel.appendChild(nameText);
    namePanel.appendChild(nameHelp);
    namePanel.appendChild(actions);

    ninResult.appendChild(namePanel);
  }

  function getRegistryFullName(result) {
    var name = result?.registryLegalName;

    if (
      !name ||
      typeof name.firstName !== "string" ||
      !name.firstName.trim() ||
      typeof name.lastName !== "string" ||
      !name.lastName.trim()
    ) {
      return "";
    }

    var parts = [name.firstName, name.middleName, name.lastName];

    return parts
      .filter(function (part) {
        return typeof part === "string" && part.trim().length > 0;
      })
      .map(function (part) {
        return part.trim();
      })
      .join(" ");
  }

  function showRegistryName(result) {
    var fullName = getRegistryFullName(result);

    if (!namePanel || !fullName) {
      return;
    }

    nameText.textContent = fullName;

    if (result.eligibleForOnboarding === true) {
      nameHelp.textContent =
        "You have confirmed this registry name. Identity-holder authentication and professional approval are separate checks.";
    } else if (result.stagingOnly === true) {
      nameHelp.textContent =
        "This is a sandbox result. Production NIN verification is required before onboarding.";
    } else {
      nameHelp.textContent =
        "Is this your correct legal name? If not, enter a different NIN. Confirming the name does not prove that you own the NIN.";
    }

    acknowledgeButton.classList.toggle(
      "d-none",
      result.acknowledged === true || result.stagingOnly === true
    );

    changeNINButton.classList.remove("d-none");
    namePanel.classList.remove("d-none");
  }

  // ───────────────────── NIN REQUEST HELPERS ─────────────────────

  function getCSRFToken() {
    var csrfInput = form?.querySelector('input[name="_csrf"]');

    return csrfInput ? csrfInput.value : "";
  }

  function getNINEndpoint(action) {
    if (!ninVerifyButton) {
      return null;
    }

    var verifyUrl = ninVerifyButton.getAttribute("data-verify-url");

    if (!verifyUrl) {
      return null;
    }

    var attribute =
      action === "acknowledge"
        ? "data-acknowledge-url"
        : action === "correction"
          ? "data-correction-url"
          : "data-verify-url";

    var configuredUrl = ninVerifyButton.getAttribute(attribute);

    try {
      var url = new URL(configuredUrl || verifyUrl, window.location.href);

      /*
       * Existing EJS may provide only the
       * verification endpoint.
       *
       * Derive the remaining URLs from
       * its known route suffix if needed.
       */

      if (!configuredUrl && action !== "verify") {
        if (!/\/verify-nin\/?$/.test(url.pathname)) {
          return null;
        }

        url.pathname = url.pathname.replace(
          /\/verify-nin\/?$/,
          action === "acknowledge" ? "/nin/acknowledge-name" : "/nin/begin-correction"
        );

        url.search = "";
        url.hash = "";
      }

      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
        return null;
      }

      return url.href;
    } catch {
      return null;
    }
  }

  async function postNINRequest(action, data) {
    var csrfToken = getCSRFToken();
    var url = getNINEndpoint(action);

    if (!csrfToken) {
      throw new Error("Your session could not be verified. Please refresh the page.");
    }

    if (!url) {
      throw new Error("NIN verification is not configured on this form.");
    }

    var payload = Object.assign({}, data, {
      _csrf: csrfToken,
    });

    var response = await axios.post(url, payload, {
      headers: {
        "X-CSRF-Token": csrfToken,
      },
    });

    if (!response.data || response.data.success !== true || !response.data.data) {
      throw new Error("Invalid NIN verification response.");
    }

    return response.data.data;
  }

  function getNINErrorMessage(error, fallback) {
    var message = error?.response?.data?.message;

    return typeof message === "string" && message.trim() ? message : fallback;
  }

  // ───────────────────── NIN STATE MANAGEMENT ─────────────────────

  function hasAcknowledgedNIN() {
    return (
      ninState === "acknowledged" &&
      currentNINResult?.status === "matched" &&
      currentNINResult?.matched === true &&
      currentNINResult?.acknowledged === true &&
      currentNINResult?.eligibleForOnboarding === true &&
      currentNINResult?.stagingOnly === false
    );
  }

  function updateNINControls() {
    var busy =
      ninRequestInProgress ||
      formValidationInProgress ||
      formSubmissionInProgress ||
      onboardingCommitted;

    var previewActive = ninState === "awaiting_acknowledgement" || ninState === "acknowledged";

    /*
     * Do not disable verification solely
     * because a rate-limit notice is active.
     *
     * The browser cannot determine whether
     * an entered NIN is:
     *
     * - A fifth distinct NIN;
     * - One of four previously attempted NINs;
     * - Eligible for a cached result.
     *
     * The backend checks eligibility before
     * authorizing another provider lookup.
     */

    if (ninVerifyButton) {
      ninVerifyButton.disabled = busy || previewActive;

      if (ninRequestInProgress) {
        ninVerifyButton.setAttribute("data-kt-indicator", "on");
      } else {
        ninVerifyButton.removeAttribute("data-kt-indicator");
      }
    }

    if (ninInput) {
      ninInput.readOnly = busy || previewActive;
    }

    if (ninConsent) {
      ninConsent.disabled = busy || previewActive;
    }

    if (acknowledgeButton) {
      acknowledgeButton.disabled = busy;
    }

    if (changeNINButton) {
      changeNINButton.disabled = busy;
    }

    if (submitButton) {
      submitButton.disabled = busy || !hasAcknowledgedNIN();
    }
  }

  function setNINLoading(loading) {
    ninRequestInProgress = loading;
    updateNINControls();
  }

  function receiveNINResult(result) {
    currentNINResult = result;

    var matched = result?.status === "matched" && result?.matched === true;

    var hasName = Boolean(getRegistryFullName(result));

    var hasReference =
      typeof result?.requestReference === "string" && result.requestReference.length > 0;

    if (matched && hasName && hasReference) {
      ninState =
        result.eligibleForOnboarding === true &&
        result.acknowledged === true &&
        result.stagingOnly === false
          ? "acknowledged"
          : "awaiting_acknowledgement";

      showNINResult(
        result.message || "Please review the legal name returned by the NIN registry.",
        getNINResultType(result)
      );

      showRegistryName(result);
    } else if (matched) {
      ninState = "unconfirmed";
      currentNINResult = null;

      showNINResult(
        "The NIN lookup did not provide a usable legal-name preview. Please contact support.",
        "warning"
      );
    } else {
      ninState = "unconfirmed";

      showNINResult(
        result?.message || "NIN verification could not be completed.",
        getNINResultType(result)
      );
    }

    updateNINControls();
  }

  // ───────────────────── NIN VERIFICATION ─────────────────────

  /*
   * NIN only. No BVN on this form.
   *
   * Each provider lookup is initiated by
   * an explicit Verify NIN click.
   *
   * There is no lookup while typing.
   * There are no automatic paid retries.
   *
   * The backend owns:
   *
   * - Provider selection;
   * - NIN hashing;
   * - Lookup attempt limits;
   * - Provider concurrency controls;
   * - Result caching;
   * - Registry-name verification;
   * - Name acknowledgement;
   * - Evidence consumption.
   */

  function handleNINVerification() {
    if (!form || !ninInput || !ninConsent || !ninVerifyButton || !ninResult || !ninMessage) {
      return;
    }

    createNameControls();
    handleNINRateLimitLifecycle();

    updateNINControls();

    // ───────── NIN INPUT ─────────

    ninInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);

      /*
       * Keep an active rate-limit notice visible
       * while the applicant enters another NIN.
       *
       * A previously attempted NIN may remain
       * eligible even when the distinct limit
       * has been reached.
       */

      if (hasActiveNINRateLimitNotice()) {
        return;
      }

      if (ninState === "unconfirmed") {
        currentNINResult = null;
        clearNINResult();
      }
    });

    // ───────── VERIFY NIN BUTTON ─────────

    ninVerifyButton.addEventListener("click", async function (event) {
      event.preventDefault();

      /*
       * Clear an expired frontend notice
       * before processing a new request.
       */

      releaseNINRateLimit();

      if (
        ninRequestInProgress ||
        formValidationInProgress ||
        formSubmissionInProgress ||
        onboardingCommitted ||
        ninState !== "unconfirmed"
      ) {
        return;
      }

      var nin = ninInput.value.trim();

      if (!/^\d{11}$/.test(nin)) {
        showNINResult("Enter a valid 11-digit National Identification Number.", "danger");

        ninInput.focus();
        return;
      }

      if (!ninConsent.checked) {
        showNINResult("Please consent to the NIN registry check before continuing.", "warning");

        ninConsent.focus();
        return;
      }

      /*
       * The frontend does not decide whether
       * a requested lookup is chargeable.
       *
       * The backend may:
       *
       * - Reuse eligible cached evidence;
       * - Permit a previously attempted NIN;
       * - Reject an excessive or new distinct NIN;
       * - Block an unresolved provider outcome.
       *
       * Every request requires an explicit click
       * and a fresh consent action.
       */

      clearNINResult();
      setNINLoading(true);

      try {
        var result = await postNINRequest("verify", {
          nin: nin,
          consentAccepted: true,
        });

        /*
         * A successful response supersedes
         * the previous frontend rate-limit notice.
         *
         * This does not reset the backend
         * lookup allowance or audit history.
         */

        clearNINRateLimitState();

        receiveNINResult(result);
      } catch (error) {
        currentNINResult = null;
        ninState = "unconfirmed";

        /*
         * Preserve a new server-provided
         * rolling-limit message when available.
         *
         * Otherwise clear the old timer so it
         * cannot overwrite a newer error message.
         */

        if (!handleNINRateLimit(error)) {
          clearNINRateLimitState();

          var statusCode = error?.response?.status;

          var message = getNINErrorMessage(
            error,
            error.message || "Unable to verify NIN at the moment. Please try again later."
          );

          showNINResult(
            message,
            statusCode === 409 || statusCode === 429 || statusCode === 503 ? "warning" : "danger"
          );
        }
      } finally {
        /*
         * Clear the raw NIN from the form
         * after the verification request.
         *
         * A subsequent lookup requires
         * the NIN to be entered again.
         *
         * Verification consent must also
         * be accepted again.
         */

        ninInput.value = "";
        ninConsent.checked = false;

        setNINLoading(false);
      }
    });

    // ───────── ACKNOWLEDGE REGISTRY NAME ─────────

    acknowledgeButton.addEventListener("click", async function () {
      if (
        ninRequestInProgress ||
        formValidationInProgress ||
        formSubmissionInProgress ||
        onboardingCommitted ||
        ninState !== "awaiting_acknowledgement" ||
        !currentNINResult ||
        currentNINResult.stagingOnly === true
      ) {
        return;
      }

      var reference = currentNINResult.requestReference;

      setNINLoading(true);

      try {
        var result = await postNINRequest("acknowledge", {
          requestReference: reference,
        });

        receiveNINResult(result);
      } catch (error) {
        showNINResult(
          getNINErrorMessage(
            error,
            error.message || "Unable to acknowledge this NIN registry name."
          ),
          "warning"
        );

        if (currentNINResult) {
          showRegistryName(currentNINResult);
        }
      } finally {
        setNINLoading(false);
      }
    });

    // ───────── ENTER A DIFFERENT NIN ─────────

    changeNINButton.addEventListener("click", async function () {
      if (
        ninRequestInProgress ||
        formValidationInProgress ||
        formSubmissionInProgress ||
        onboardingCommitted ||
        (ninState !== "awaiting_acknowledgement" && ninState !== "acknowledged") ||
        !currentNINResult
      ) {
        return;
      }

      var reference = currentNINResult.requestReference;

      setNINLoading(true);

      try {
        /*
         * This request invalidates the previous
         * acknowledgement server-side.
         *
         * It does not initiate another
         * chargeable provider lookup.
         */

        await postNINRequest("correction", {
          requestReference: reference,
        });

        currentNINResult = null;
        ninState = "unconfirmed";

        ninInput.value = "";
        ninInput.placeholder = "Enter your 11-digit NIN";

        ninConsent.checked = false;

        /*
         * Remove any stale notice associated
         * with the previous verification result.
         *
         * Backend lookup history is unaffected.
         */

        clearNINRateLimitState();

        showNINResult(
          "Enter a different NIN, accept the verification consent and click Verify NIN.",
          "info"
        );
      } catch (error) {
        showNINResult(
          getNINErrorMessage(error, error.message || "Unable to change NIN at the moment."),
          "warning"
        );

        if (currentNINResult) {
          showRegistryName(currentNINResult);
        }
      } finally {
        setNINLoading(false);

        if (ninState === "unconfirmed") {
          ninInput.focus();
        }
      }
    });
  }

  // ───────────────────── FORM SUBMISSION ─────────────────────

  function showFormAlert(message, type) {
    return Swal.fire({
      text: message,
      icon: type,

      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function handleFormSubmission() {
    if (!form || !submitButton) {
      return;
    }

    validator = FormValidation.formValidation(form, {
      fields: {
        licenceNumber: {
          validators: {
            notEmpty: {
              message: "Licence number is required.",
            },

            regexp: {
              regexp: /^[0-9]{6}$/,
              message: "Licence number must be exactly 6 digits.",
            },
          },
        },

        phone: {
          validators: {
            notEmpty: {
              message: "Phone number is required.",
            },
          },
        },

        specialty: {
          validators: {
            notEmpty: {
              message: "Please select your specialty.",
            },
          },
        },

        address: {
          validators: {
            notEmpty: {
              message: "Work/Base address is required.",
            },
          },
        },

        state: {
          validators: {
            notEmpty: {
              message: "Please select a state.",
            },
          },
        },

        lga: {
          validators: {
            notEmpty: {
              message: "Please select an LGA.",
            },
          },
        },
      },

      plugins: {
        trigger: new FormValidation.plugins.Trigger(),

        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row, .col-md-6",

          eleInvalidClass: "",
          eleValidClass: "",
        }),
      },
    });

    // ───────── SUBMIT HANDLER ─────────

    /*
     * Listen on the form, not only the submit
     * button, so pressing Enter cannot bypass
     * frontend validation.
     */

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (formValidationInProgress || formSubmissionInProgress || onboardingCommitted) {
        return;
      }

      if (ninRequestInProgress) {
        showNINResult("Please wait for the NIN verification request to finish.", "warning");

        if (currentNINResult) {
          showRegistryName(currentNINResult);
        }

        return;
      }

      // ───────── REQUIRE ACKNOWLEDGED NIN ─────────

      if (!hasAcknowledgedNIN()) {
        showNINResult(
          "Verify your NIN and confirm the legal name returned by the registry before completing onboarding.",
          "warning"
        );

        if (currentNINResult) {
          showRegistryName(currentNINResult);
        }

        return;
      }

      // ───────── PROFILE VALIDATION ─────────

      formValidationInProgress = true;
      updateNINControls();

      var status;

      try {
        status = await validator.validate();
      } catch {
        await showFormAlert("Unable to validate your profile. Please try again.", "error");

        return;
      } finally {
        formValidationInProgress = false;
        updateNINControls();
      }

      if (status !== "Valid") {
        return;
      }

      // ───────── GOOGLE PLACES VALIDATION ─────────

      var latitudeInput = document.querySelector("#latitudeInput");
      var longitudeInput = document.querySelector("#longitudeInput");
      var googlePlaceIdInput = document.querySelector("#googlePlaceIdInput");

      if (!latitudeInput?.value || !longitudeInput?.value || !googlePlaceIdInput?.value) {
        await showFormAlert("Please select a valid address from the suggestions.", "error");

        return;
      }

      // ───────── SUBMIT PROFILE ─────────

      formSubmissionInProgress = true;

      submitButton.setAttribute("data-kt-indicator", "on");

      updateNINControls();

      /*
       * Submit only ordinary profile fields.
       *
       * NIN, acknowledgement and legal-name
       * evidence are held server-side.
       */

      var formData = new FormData(form);
      var data = Object.fromEntries(formData);

      delete data.nin;
      delete data.consentAccepted;
      delete data.requestReference;
      delete data.registryLegalName;

      delete data.firstName;
      delete data.middleName;
      delete data.lastName;
      delete data.dateOfBirth;

      try {
        var response = await axios.post(form.action, data);

        if (!response.data || response.data.success !== true) {
          throw new Error("Unable to complete your profile.");
        }

        onboardingCommitted = true;

        await Swal.fire({
          text: response.data.message || "Profile completed!",

          icon: "success",

          buttonsStyling: false,
          confirmButtonText: "Go to Dashboard",

          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        // ───────── SAFE REDIRECT ─────────

        var redirectUrl = response.data.redirectUrl;

        if (
          typeof redirectUrl !== "string" ||
          !redirectUrl.startsWith("/") ||
          redirectUrl.startsWith("//")
        ) {
          redirectUrl = "/professional/dashboard";
        }

        window.location.href = redirectUrl;
      } catch (error) {
        if (error.response?.data?.onboardingCompleted === true) {
          onboardingCommitted = true;

          await showFormAlert(
            error.response.data.message ||
              "Your profile was saved. Please sign in again to continue.",
            "warning"
          );
        } else {
          await showFormAlert(
            error.response?.data?.message || "An error occurred while completing your profile.",
            "error"
          );
        }
      } finally {
        formSubmissionInProgress = false;

        submitButton.removeAttribute("data-kt-indicator");

        updateNINControls();
      }
    });
  }

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      if (!form) {
        return;
      }

      LocationPicker.init("#stateSelect", "#lgaSelect");

      SpecialtyPicker.init('input[name="type"]', "#specialtySelect");

      handleFormSubmission();
      handleTypeSwitching();
      handleNINVerification();
    },
  };
})();

// ───────────────────── GOOGLE PLACES ─────────────────────

window.initAddressAutocomplete = function () {
  var addressInput = document.querySelector("#addressInput");
  var latitudeInput = document.querySelector("#latitudeInput");
  var longitudeInput = document.querySelector("#longitudeInput");
  var googlePlaceIdInput = document.querySelector("#googlePlaceIdInput");

  if (
    !addressInput ||
    !latitudeInput ||
    !longitudeInput ||
    !googlePlaceIdInput ||
    !window.google ||
    !google.maps ||
    !google.maps.places
  ) {
    return;
  }

  var autocomplete = new google.maps.places.Autocomplete(addressInput, {
    componentRestrictions: {
      country: "ng",
    },

    fields: ["formatted_address", "geometry", "place_id"],

    types: ["geocode"],
  });

  /*
   * Manual edits invalidate the previously
   * selected Google Places coordinates.
   */

  addressInput.addEventListener("input", function () {
    latitudeInput.value = "";
    longitudeInput.value = "";
    googlePlaceIdInput.value = "";
  });

  autocomplete.addListener("place_changed", function () {
    var place = autocomplete.getPlace();

    if (!place.geometry || !place.geometry.location) {
      latitudeInput.value = "";
      longitudeInput.value = "";
      googlePlaceIdInput.value = "";
      return;
    }

    addressInput.value = place.formatted_address || addressInput.value;

    latitudeInput.value = place.geometry.location.lat();
    longitudeInput.value = place.geometry.location.lng();
    googlePlaceIdInput.value = place.place_id || "";
  });
};

// ───────────────────── DOCUMENT READY ─────────────────────

KTUtil.onDOMContentLoaded(function () {
  OnboardingProfessional.init();
});
