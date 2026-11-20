// public/js/professional/shift-details.js

(function () {
  "use strict";

  const FLASH_STORAGE_KEY = "loqum:professional-shift:action-feedback";

  const ATTENDANCE_FORM_SELECTOR = "[data-professional-shift-attendance]";
  const APPLICATION_FORM_SELECTOR = "form[data-professional-shift-apply]";
  const WITHDRAWAL_FORM_SELECTOR = "form[data-professional-shift-withdraw]";

  const LOCATION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0,
  });

  let isSubmitting = false;

  /* ─────────────────────────────── HELPERS ─────────────────────────────── */

  function getElement(selector, context = document) {
    return context.querySelector(selector);
  }

  function getElements(selector, context = document) {
    return Array.from(context.querySelectorAll(selector));
  }

  function show(element) {
    if (element) {
      element.classList.remove("d-none");
    }
  }

  function hide(element) {
    if (element) {
      element.classList.add("d-none");
    }
  }

  function getCsrfToken(form) {
    const input = getElement('input[name="_csrf"]', form);

    return String(input?.value || "").trim();
  }

  function createError(message, code = null) {
    const error = new Error(message);

    if (code) {
      error.code = code;
    }

    return error;
  }

  function normalizeError(error) {
    if (error instanceof Error) {
      return error;
    }

    return createError(
      typeof error === "string" ? error : "Something went wrong. Please try again."
    );
  }

  function getErrorElement(form) {
    return (
      getElement("[data-attendance-form-error]", form) ||
      getElement("[data-shift-form-error]", form)
    );
  }

  function clearFormError(form) {
    const element = getErrorElement(form);

    if (!element) {
      return;
    }

    element.textContent = "";

    hide(element);
  }

  function showFormError(form, error) {
    const element = getErrorElement(form);

    const normalizedError = normalizeError(error);

    if (!element) {
      showGlobalFeedback(normalizedError.message, "danger");
      return;
    }

    element.textContent = normalizedError.message;

    show(element);

    element.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }

  function showGlobalFeedback(message, type = "success") {
    const element = getElement("#professionalShiftActionFeedback");

    if (!element) {
      return;
    }

    element.classList.remove("alert-success", "alert-danger", "alert-warning", "alert-info");

    element.classList.add(`alert-${type}`);

    element.textContent = message;

    show(element);
  }

  function clearGlobalFeedback() {
    const element = getElement("#professionalShiftActionFeedback");

    if (!element) {
      return;
    }

    element.textContent = "";

    hide(element);
  }

  function storeFlash(message, type = "success") {
    try {
      sessionStorage.setItem(
        FLASH_STORAGE_KEY,
        JSON.stringify({
          message,
          type,
          pathname: window.location.pathname,
        })
      );
    } catch (error) {
      // Storage may be unavailable in restricted browser contexts.
    }
  }

  function restoreFlash() {
    let stored = null;

    try {
      stored = sessionStorage.getItem(FLASH_STORAGE_KEY);

      if (stored) {
        sessionStorage.removeItem(FLASH_STORAGE_KEY);
      }
    } catch (error) {
      return;
    }

    if (!stored) {
      return;
    }

    try {
      const feedback = JSON.parse(stored);

      if (!feedback || feedback.pathname !== window.location.pathname || !feedback.message) {
        return;
      }

      showGlobalFeedback(feedback.message, feedback.type || "success");
    } catch (error) {
      // Ignore invalid transient feedback.
    }
  }

  function setFormSubmitting(form, submitting) {
    const button =
      getElement("[data-attendance-form-submit]", form) ||
      getElement("[data-shift-form-submit]", form);

    if (!button) {
      return;
    }

    button.disabled = submitting;

    if (submitting) {
      button.setAttribute("data-kt-indicator", "on");
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("data-kt-indicator");
      button.removeAttribute("aria-busy");
    }
  }

  async function executeFormAction(form, action) {
    if (isSubmitting) {
      return;
    }

    isSubmitting = true;

    clearFormError(form);
    clearGlobalFeedback();

    setFormSubmitting(form, true);

    try {
      await action();
    } catch (error) {
      showFormError(form, error);
    } finally {
      isSubmitting = false;

      setFormSubmitting(form, false);
    }
  }

  async function readResponse(response) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();

    let result = null;

    if (contentType.includes("application/json")) {
      try {
        result = await response.json();
      } catch (error) {
        throw createError(
          "The server returned an invalid response. Please try again.",
          "INVALID_SERVER_RESPONSE"
        );
      }
    } else {
      const text = await response.text();

      if (!response.ok) {
        throw createError(
          response.status === 403
            ? "Your session or security token has expired. Refresh the page and try again."
            : `The request could not be completed (${response.status}).`,
          "NON_JSON_ERROR_RESPONSE"
        );
      }

      throw createError(
        "The server returned an unexpected response. Please refresh the page.",
        "UNEXPECTED_SERVER_RESPONSE"
      );
    }

    if (!response.ok || result?.success !== true) {
      const error = createError(
        result?.message || "The request could not be completed. Please try again.",
        result?.code || "REQUEST_FAILED"
      );

      error.statusCode = response.status;
      error.details = result?.details || null;

      throw error;
    }

    return result;
  }

  async function postRequest({ url, body, csrfToken, contentType = null }) {
    if (!url) {
      throw createError("The action URL is unavailable.");
    }

    if (!csrfToken) {
      throw createError("The security token is unavailable. Refresh the page and try again.");
    }

    const headers = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "CSRF-Token": csrfToken,
    };

    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body,
        redirect: "follow",
      });
    } catch (error) {
      throw createError(
        "Unable to connect to Loqum. Check your internet connection and try again.",
        "NETWORK_ERROR"
      );
    }

    return readResponse(response);
  }

  async function postJson(form, payload) {
    const csrfToken = getCsrfToken(form);

    return postRequest({
      url: form.action,
      csrfToken,
      contentType: "application/json",
      body: JSON.stringify({
        _csrf: csrfToken,
        ...payload,
      }),
    });
  }

  async function postUrlEncoded(form) {
    const csrfToken = getCsrfToken(form);

    const formData = new FormData(form);

    return postRequest({
      url: form.action,
      csrfToken,
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      body: new URLSearchParams(formData).toString(),
    });
  }

  function completeAction(message) {
    storeFlash(message, "success");

    window.location.reload();
  }

  /* ─────────────────────────────── APPLICATIONS ─────────────────────────────── */

  function initializeApplicationForms() {
    getElements(APPLICATION_FORM_SELECTOR).forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        await executeFormAction(form, async () => {
          if (!form.reportValidity()) {
            return;
          }

          const result = await postUrlEncoded(form);

          completeAction(result.message || "Your application has been submitted.");
        });
      });
    });
  }

  function initializeWithdrawalForms() {
    getElements(WITHDRAWAL_FORM_SELECTOR).forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!window.confirm("Are you sure you want to withdraw this application?")) {
          return;
        }

        await executeFormAction(form, async () => {
          if (!form.reportValidity()) {
            return;
          }

          const result = await postUrlEncoded(form);

          completeAction(result.message || "Your application has been withdrawn.");
        });
      });
    });
  }

  /* ─────────────────────────────── PIN INPUT ─────────────────────────────── */

  function initializePinInput(form) {
    const container = getElement("[data-attendance-pin]", form);
    const hiddenInput = getElement("[data-attendance-pin-value]", form);

    if (!container || !hiddenInput) {
      return null;
    }

    const inputs = getElements("[data-attendance-pin-digit]", container);

    const expectedLength = Number(container.dataset.attendancePinLength || 4);

    if (
      !Number.isInteger(expectedLength) ||
      expectedLength <= 0 ||
      inputs.length !== expectedLength
    ) {
      throw createError("The attendance PIN interface is incorrectly configured.");
    }

    function updateHiddenInput() {
      hiddenInput.value = inputs.map((input) => input.value).join("");
    }

    function focusInput(index) {
      const input = inputs[index];

      if (!input) {
        return;
      }

      input.focus();
      input.select();
    }

    function setDigit(index, value) {
      const input = inputs[index];

      if (!input) {
        return;
      }

      input.value = String(value || "")
        .replace(/\D/g, "")
        .slice(0, 1);
    }

    function distributeDigits(startIndex, value) {
      const digits = String(value || "")
        .replace(/\D/g, "")
        .split("");

      if (digits.length === 0) {
        return;
      }

      let lastIndex = startIndex;

      digits.forEach((digit, offset) => {
        const index = startIndex + offset;

        if (index >= inputs.length) {
          return;
        }

        setDigit(index, digit);

        lastIndex = index;
      });

      updateHiddenInput();

      const nextIndex = Math.min(lastIndex + 1, inputs.length - 1);

      focusInput(nextIndex);
    }

    inputs.forEach((input, index) => {
      input.setAttribute("inputmode", "numeric");
      input.setAttribute("autocomplete", "off");

      input.addEventListener("input", () => {
        clearFormError(form);

        const digits = String(input.value || "").replace(/\D/g, "");

        if (digits.length === 0) {
          input.value = "";
          updateHiddenInput();
          return;
        }

        if (digits.length > 1) {
          distributeDigits(index, digits);
          return;
        }

        input.value = digits;

        updateHiddenInput();

        if (index < inputs.length - 1) {
          focusInput(index + 1);
        }
      });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Backspace") {
          event.preventDefault();

          if (input.value) {
            input.value = "";

            updateHiddenInput();

            return;
          }

          if (index > 0) {
            inputs[index - 1].value = "";

            updateHiddenInput();

            focusInput(index - 1);
          }

          return;
        }

        if (event.key === "Delete") {
          event.preventDefault();

          input.value = "";

          updateHiddenInput();

          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();

          if (index > 0) {
            focusInput(index - 1);
          }

          return;
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();

          if (index < inputs.length - 1) {
            focusInput(index + 1);
          }

          return;
        }

        if (event.key === "Home") {
          event.preventDefault();
          focusInput(0);
          return;
        }

        if (event.key === "End") {
          event.preventDefault();
          focusInput(inputs.length - 1);
        }
      });

      input.addEventListener("paste", (event) => {
        const pastedText = event.clipboardData?.getData("text") || "";

        const digits = pastedText.replace(/\D/g, "");

        if (!digits) {
          return;
        }

        event.preventDefault();

        distributeDigits(index, digits);
      });

      input.addEventListener("focus", () => {
        input.select();
      });
    });

    updateHiddenInput();

    return {
      getValue() {
        updateHiddenInput();

        const pin = hiddenInput.value;

        if (!new RegExp(`^\\d{${expectedLength}}$`).test(pin)) {
          const firstEmptyIndex = inputs.findIndex((input) => !/^\d$/.test(input.value));

          focusInput(firstEmptyIndex >= 0 ? firstEmptyIndex : 0);

          throw createError(
            `Enter the complete ${expectedLength}-digit attendance PIN.`,
            "ATTENDANCE_PIN_INCOMPLETE"
          );
        }

        return pin;
      },

      clear() {
        inputs.forEach((input) => {
          input.value = "";
        });

        updateHiddenInput();

        focusInput(0);
      },
    };
  }

  /* ─────────────────────────────── GEOLOCATION ─────────────────────────────── */

  function getCurrentLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(
          createError(
            "Your browser does not support location access. Use a browser with geolocation support.",
            "GEOLOCATION_UNAVAILABLE"
          )
        );

        return;
      }

      if (!window.isSecureContext) {
        reject(
          createError(
            "Location verification requires a secure HTTPS connection.",
            "GEOLOCATION_INSECURE_CONTEXT"
          )
        );

        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const latitude = Number(position.coords?.latitude);

          const longitude = Number(position.coords?.longitude);

          const accuracyMeters = Number(position.coords?.accuracy);

          if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            !Number.isFinite(accuracyMeters) ||
            accuracyMeters < 0
          ) {
            reject(
              createError(
                "Your device returned invalid location information. Please try again.",
                "GEOLOCATION_INVALID"
              )
            );

            return;
          }

          const capturedAt = new Date(position.timestamp).toISOString();

          resolve({
            latitude,
            longitude,
            accuracyMeters,
            capturedAt,
            locationSource: "browser",
          });
        },

        (error) => {
          let message = "Your current location could not be obtained. Please try again.";

          if (error.code === 1) {
            message =
              "Location permission was denied. Enable location access in your browser and try again.";
          } else if (error.code === 2) {
            message =
              "Your device could not determine your location. Check your location settings and try again.";
          } else if (error.code === 3) {
            message =
              "Location verification timed out. Move to an area with better GPS reception and try again.";
          }

          reject(createError(message, "GEOLOCATION_FAILED"));
        },

        LOCATION_OPTIONS
      );
    });
  }

  /* ─────────────────────────────── LATE CHECKOUT ─────────────────────────────── */

  function initializeLateCheckout(form) {
    const lateFields = getElement("[data-attendance-late-fields]", form);

    const lateOption = getElement("[data-attendance-late-option]", form);

    const normalFields = getElement("[data-attendance-normal-late-fields]", form);

    const lateReason = getElement("[data-attendance-late-reason]", form);

    const lateNotes = getElement("[data-attendance-late-notes]", form);

    const overtimeFields = getElement("[data-attendance-overtime-fields]", form);

    const overtimeStatement = getElement("[data-attendance-overtime-statement]", form);

    const overtimeMinutes = getElement("[data-attendance-overtime-minutes]", form);

    const scheduledEndTime = Date.parse(String(form.dataset.scheduledEndTime || ""));

    if (!Number.isFinite(scheduledEndTime)) {
      throw createError(
        "The scheduled checkout time is unavailable. Refresh the page before checking out."
      );
    }

    function isLate() {
      return Date.now() > scheduledEndTime;
    }

    let evidenceManager = null;

    function attachEvidenceManager(manager) {
      evidenceManager = manager;

      synchronize();
    }

    function synchronize() {
      const late = isLate();

      if (late) {
        show(lateFields);
      } else {
        hide(lateFields);
      }

      if (lateOption) {
        lateOption.disabled = !late;
        lateOption.required = late;
      }

      const selectedOption = late ? String(lateOption?.value || "") : "";

      const normalLateSelected = selectedOption === "normal_late_checkout";

      const overtimeSelected = selectedOption === "overtime_requested";

      if (normalLateSelected) {
        show(normalFields);
      } else {
        hide(normalFields);
      }

      if (overtimeSelected) {
        show(overtimeFields);
      } else {
        hide(overtimeFields);
      }

      if (lateReason) {
        lateReason.disabled = !normalLateSelected;
        lateReason.required = normalLateSelected;
      }

      if (lateNotes) {
        lateNotes.disabled = !normalLateSelected;

        lateNotes.required = normalLateSelected && lateReason?.value === "other";
      }

      if (overtimeStatement) {
        overtimeStatement.disabled = !overtimeSelected;
        overtimeStatement.required = overtimeSelected;
      }

      if (overtimeMinutes) {
        overtimeMinutes.disabled = !overtimeSelected;
      }

      if (evidenceManager) {
        evidenceManager.setEnabled(overtimeSelected);
      }

      return {
        late,
        selectedOption,
        normalLateSelected,
        overtimeSelected,
      };
    }

    if (lateOption) {
      lateOption.addEventListener("change", () => {
        clearFormError(form);
        synchronize();
      });
    }

    if (lateReason) {
      lateReason.addEventListener("change", () => {
        clearFormError(form);
        synchronize();
      });
    }

    window.addEventListener("focus", synchronize);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        synchronize();
      }
    });

    window.setInterval(synchronize, 30000);

    synchronize();

    return {
      synchronize,
      attachEvidenceManager,

      validate() {
        const state = synchronize();

        if (!state.late) {
          return state;
        }

        if (!state.selectedOption) {
          lateOption?.focus();

          throw createError(
            "Select whether you worked overtime before checking out.",
            "LATE_CHECKOUT_OPTION_REQUIRED"
          );
        }

        if (
          state.selectedOption !== "normal_late_checkout" &&
          state.selectedOption !== "overtime_requested"
        ) {
          throw createError(
            "The selected late-checkout option is invalid.",
            "LATE_CHECKOUT_OPTION_INVALID"
          );
        }

        if (state.normalLateSelected) {
          if (!String(lateReason?.value || "").trim()) {
            lateReason?.focus();

            throw createError(
              "Select a reason for checking out late.",
              "LATE_CHECKOUT_REASON_REQUIRED"
            );
          }

          if (lateReason.value === "other" && !String(lateNotes?.value || "").trim()) {
            lateNotes?.focus();

            throw createError(
              "Provide additional details for the selected reason.",
              "LATE_CHECKOUT_NOTES_REQUIRED"
            );
          }
        }

        if (state.overtimeSelected) {
          if (!String(overtimeStatement?.value || "").trim()) {
            overtimeStatement?.focus();

            throw createError(
              "Explain the additional work performed before submitting your overtime request.",
              "OVERTIME_STATEMENT_REQUIRED"
            );
          }

          const rawMinutes = String(overtimeMinutes?.value || "").trim();

          if (rawMinutes) {
            const minutes = Number(rawMinutes);

            if (
              !Number.isSafeInteger(minutes) ||
              minutes <= 0 ||
              minutes > Number(overtimeMinutes.max)
            ) {
              overtimeMinutes?.focus();

              throw createError(
                `Overtime minutes must be a whole number between 1 and ${overtimeMinutes.max}.`,
                "OVERTIME_MINUTES_INVALID"
              );
            }
          }
        }

        return state;
      },
    };
  }

  /* ─────────────────────────────── EVIDENCE UPLOAD ─────────────────────────────── */

  function getFileExtension(fileName) {
    const name = String(fileName || "").toLowerCase();

    const lastDot = name.lastIndexOf(".");

    return lastDot >= 0 ? name.slice(lastDot) : "";
  }

  function parseAcceptedExtensions(value) {
    return String(value || "")
      .split(",")
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean);
  }

  function initializeEvidenceUpload(form) {
    const container = getElement("[data-attendance-evidence]", form);

    if (!container) {
      return null;
    }

    const items = getElements("[data-attendance-evidence-item]", container);

    const addButton = getElement("[data-attendance-evidence-add]", container);

    const manifestInput = getElement("[data-attendance-evidence-manifest]", container);

    const maxFiles = Number(container.dataset.attendanceEvidenceMaxFiles || 3);

    const maxBytes = Number(container.dataset.attendanceEvidenceMaxBytes || 0);

    if (
      !Number.isInteger(maxFiles) ||
      maxFiles <= 0 ||
      items.length !== maxFiles ||
      !Number.isFinite(maxBytes) ||
      maxBytes <= 0 ||
      !manifestInput
    ) {
      throw createError("The overtime evidence upload interface is incorrectly configured.");
    }

    const fileFieldName = getElement("[data-attendance-evidence-file]", container)?.name;

    if (!fileFieldName) {
      throw createError("The overtime evidence file field is unavailable.");
    }

    let enabled = false;

    function isItemVisible(item) {
      return !item.classList.contains("d-none");
    }

    function getItemControls(item) {
      return {
        type: getElement("[data-attendance-evidence-type]", item),

        file: getElement("[data-attendance-evidence-file]", item),

        description: getElement("[data-attendance-evidence-description]", item),
      };
    }

    function clearItem(item) {
      const controls = getItemControls(item);

      if (controls.type) {
        controls.type.value = "";
      }

      if (controls.file) {
        controls.file.value = "";
        controls.file.removeAttribute("accept");
      }

      if (controls.description) {
        controls.description.value = "";
      }
    }

    function updateAcceptedFormats(item) {
      const controls = getItemControls(item);

      if (!controls.type || !controls.file) {
        return;
      }

      const selectedOption = controls.type.selectedOptions[0];

      const accept = String(selectedOption?.dataset.accept || "").trim();

      if (accept) {
        controls.file.setAttribute("accept", accept);
      } else {
        controls.file.removeAttribute("accept");
      }

      const selectedFile = controls.file.files?.[0];

      if (
        selectedFile &&
        accept &&
        !parseAcceptedExtensions(accept).includes(getFileExtension(selectedFile.name))
      ) {
        controls.file.value = "";
      }
    }

    function refreshControls() {
      let visibleCount = 0;

      items.forEach((item) => {
        const visible = isItemVisible(item);

        if (visible) {
          visibleCount += 1;
        }

        const controls = getItemControls(item);

        const controlsEnabled = enabled && visible;

        if (controls.type) {
          controls.type.disabled = !controlsEnabled;
        }

        if (controls.file) {
          controls.file.disabled = !controlsEnabled;
        }

        if (controls.description) {
          controls.description.disabled = !controlsEnabled;
        }

        const removeButton = getElement("[data-attendance-evidence-remove]", item);

        if (removeButton) {
          removeButton.disabled = !controlsEnabled;
        }
      });

      manifestInput.disabled = !enabled;

      if (addButton) {
        addButton.disabled = !enabled || visibleCount >= maxFiles;

        addButton.classList.toggle("d-none", visibleCount >= maxFiles);
      }
    }

    function showNextItem() {
      if (!enabled) {
        return;
      }

      const nextItem = items.find((item) => !isItemVisible(item));

      if (!nextItem) {
        return;
      }

      show(nextItem);

      refreshControls();

      getItemControls(nextItem).type?.focus();
    }

    function removeItem(item) {
      clearItem(item);

      hide(item);

      refreshControls();
    }

    function validateSelectedFile(file, type, item) {
      const controls = getItemControls(item);

      if (!type) {
        throw createError(
          "Select the evidence type for each uploaded file.",
          "OVERTIME_EVIDENCE_TYPE_REQUIRED"
        );
      }

      if (!file) {
        throw createError(
          "Choose a file for each evidence entry you have added.",
          "OVERTIME_EVIDENCE_FILE_REQUIRED"
        );
      }

      if (file.size === 0) {
        throw createError(
          `${file.name} is empty. Choose a valid file.`,
          "OVERTIME_EVIDENCE_FILE_EMPTY"
        );
      }

      if (file.size > maxBytes) {
        const maxMb = maxBytes / (1024 * 1024);

        throw createError(
          `${file.name} exceeds the ${maxMb} MB evidence file limit.`,
          "OVERTIME_EVIDENCE_FILE_TOO_LARGE"
        );
      }

      const selectedOption = controls.type.selectedOptions[0];

      const acceptedExtensions = parseAcceptedExtensions(selectedOption?.dataset.accept);

      if (
        acceptedExtensions.length === 0 ||
        !acceptedExtensions.includes(getFileExtension(file.name))
      ) {
        throw createError(
          `${file.name} is not a supported format for the selected evidence type.`,
          "OVERTIME_EVIDENCE_FORMAT_INVALID"
        );
      }
    }

    function collectEvidence() {
      if (!enabled) {
        return {
          files: [],
          manifest: [],
        };
      }

      const files = [];
      const manifest = [];

      items.forEach((item) => {
        if (!isItemVisible(item)) {
          return;
        }

        const controls = getItemControls(item);

        const type = String(controls.type?.value || "").trim();

        const file = controls.file?.files?.[0] || null;

        const description = String(controls.description?.value || "").trim();

        // A completely empty evidence row is optional.
        if (!type && !file && !description) {
          return;
        }

        try {
          validateSelectedFile(file, type, item);
        } catch (error) {
          if (!type) {
            controls.type?.focus();
          } else {
            controls.file?.focus();
          }

          throw error;
        }

        if (description.length > Number(controls.description?.maxLength || 500)) {
          controls.description?.focus();

          throw createError(
            "An evidence description cannot exceed 500 characters.",
            "OVERTIME_EVIDENCE_DESCRIPTION_TOO_LONG"
          );
        }

        files.push(file);

        manifest.push({
          type,
          description: description || null,
        });
      });

      if (files.length > maxFiles) {
        throw createError(
          `You may upload a maximum of ${maxFiles} supporting files.`,
          "OVERTIME_EVIDENCE_TOO_MANY_FILES"
        );
      }

      return {
        files,
        manifest,
      };
    }

    items.forEach((item, index) => {
      const controls = getItemControls(item);

      if (controls.type) {
        controls.type.addEventListener("change", () => {
          clearFormError(form);
          updateAcceptedFormats(item);
        });
      }

      if (controls.file) {
        controls.file.addEventListener("change", () => {
          clearFormError(form);

          const file = controls.file.files?.[0];

          if (!file) {
            return;
          }

          try {
            validateSelectedFile(file, controls.type?.value || "", item);
          } catch (error) {
            controls.file.value = "";
            showFormError(form, error);
          }
        });
      }

      const removeButton = getElement("[data-attendance-evidence-remove]", item);

      if (removeButton) {
        removeButton.addEventListener("click", () => {
          removeItem(item);
          clearFormError(form);
        });
      }

      if (index > 0) {
        hide(item);
      }

      updateAcceptedFormats(item);
    });

    if (addButton) {
      addButton.addEventListener("click", () => {
        clearFormError(form);
        showNextItem();
      });
    }

    refreshControls();

    return {
      setEnabled(value) {
        enabled = value === true;

        refreshControls();
      },

      getEnabled() {
        return enabled;
      },

      buildFormData(formData) {
        // Exclude empty file fields generated by FormData(form).
        formData.delete(fileFieldName);

        const evidence = collectEvidence();

        evidence.files.forEach((file) => {
          formData.append(fileFieldName, file, file.name);
        });

        if (enabled) {
          manifestInput.value = JSON.stringify(evidence.manifest);

          formData.set(manifestInput.name, manifestInput.value);
        } else {
          formData.delete(manifestInput.name);
        }

        return formData;
      },
    };
  }

  /* ─────────────────────────────── CHECK-IN ─────────────────────────────── */

  function initializeCheckIn(form) {
    const pinManager = initializePinInput(form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      await executeFormAction(form, async () => {
        if (!pinManager) {
          throw createError("The check-in PIN interface is unavailable.");
        }

        const pin = pinManager.getValue();

        const location = await getCurrentLocation();

        const result = await postJson(form, {
          pin,
          location,
        });

        completeAction(result.message || "You have checked in successfully.");
      });
    });
  }

  /* ─────────────────────────────── CHECKOUT ─────────────────────────────── */

  function initializeCheckOut(form) {
    const pinManager = initializePinInput(form);

    const lateCheckoutManager = initializeLateCheckout(form);

    const evidenceManager = initializeEvidenceUpload(form);

    if (evidenceManager) {
      lateCheckoutManager.attachEvidenceManager(evidenceManager);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      await executeFormAction(form, async () => {
        if (!pinManager) {
          throw createError("The checkout PIN interface is unavailable.");
        }

        const pin = pinManager.getValue();

        // Validate the late-checkout decision before requesting GPS.
        let lateCheckoutState = lateCheckoutManager.validate();

        if (!form.reportValidity()) {
          return;
        }

        const location = await getCurrentLocation();

        // Recheck because the scheduled end time may pass while GPS loads.
        lateCheckoutState = lateCheckoutManager.validate();

        if (!form.reportValidity()) {
          return;
        }

        const csrfToken = getCsrfToken(form);

        const formData = new FormData(form);

        formData.set("_csrf", csrfToken);

        formData.set("pin", pin);

        formData.set("location", JSON.stringify(location));

        if (evidenceManager) {
          evidenceManager.buildFormData(formData);
        }

        // Disabled fields are automatically excluded by FormData.
        // No overtime fields are submitted for normal checkout.
        if (!lateCheckoutState.late) {
          formData.delete("lateCheckoutOption");
          formData.delete("lateCheckoutReason");
          formData.delete("lateCheckoutNotes");
          formData.delete("requestStatement");
          formData.delete("requestedOvertimeMinutes");
        } else if (lateCheckoutState.selectedOption === "normal_late_checkout") {
          formData.delete("requestStatement");
          formData.delete("requestedOvertimeMinutes");
        } else if (lateCheckoutState.selectedOption === "overtime_requested") {
          formData.delete("lateCheckoutReason");
          formData.delete("lateCheckoutNotes");
        }

        // Do not manually set multipart Content-Type.
        // The browser must supply the boundary.
        const result = await postRequest({
          url: form.action,
          csrfToken,
          body: formData,
        });

        completeAction(result.message || "You have checked out successfully.");
      });
    });
  }

  /* ─────────────────────────────── CHECKOUT FALLBACK ─────────────────────────────── */

  function initializeCheckoutFallback(form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      await executeFormAction(form, async () => {
        if (!form.reportValidity()) {
          return;
        }

        const reason = String(getElement('[name="reason"]', form)?.value || "").trim();

        const notes = String(getElement('[name="notes"]', form)?.value || "").trim();

        if (!reason) {
          throw createError("Select a reason for your checkout review request.");
        }

        const result = await postJson(form, {
          reason,
          notes: notes || null,
        });

        completeAction(result.message || "Your checkout review request has been submitted.");
      });
    });
  }

  /* ─────────────────────────────── ABSENCE EXPLANATION ─────────────────────────────── */

  function initializeAbsenceExplanation(form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      await executeFormAction(form, async () => {
        if (!form.reportValidity()) {
          return;
        }

        const explanation = String(getElement('[name="explanation"]', form)?.value || "").trim();

        if (!explanation) {
          throw createError("Provide an explanation for your absence.");
        }

        if (
          !window.confirm("Submit this absence explanation? You cannot edit it after submission.")
        ) {
          return;
        }

        const result = await postJson(form, {
          explanation,
        });

        completeAction(result.message || "Your absence explanation has been submitted.");
      });
    });
  }

  /* ─────────────────────────────── ATTENDANCE INITIALIZATION ─────────────────────────────── */

  function initializeAttendanceForms() {
    getElements(ATTENDANCE_FORM_SELECTOR).forEach((form) => {
      const action = String(form.dataset.professionalShiftAttendance || "").trim();

      try {
        switch (action) {
          case "check-in":
            initializeCheckIn(form);
            break;

          case "check-out":
            initializeCheckOut(form);
            break;

          case "checkout-fallback":
            initializeCheckoutFallback(form);
            break;

          case "absence-explanation":
            initializeAbsenceExplanation(form);
            break;

          default:
            break;
        }
      } catch (error) {
        showFormError(form, error);

        const submitButton = getElement("[data-attendance-form-submit]", form);

        if (submitButton) {
          submitButton.disabled = true;
        }
      }
    });
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  function initialize() {
    restoreFlash();

    initializeApplicationForms();

    initializeWithdrawalForms();

    initializeAttendanceForms();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
