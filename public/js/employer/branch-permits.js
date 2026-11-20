// public/js/employer/branch-permits.js

var EmployerBranchPermits = (function () {
  var permitPage = null;
  var permitForm = null;
  var permitSubmitButton = null;
  var permitRequirementInput = null;
  var permitRequirementLabel = null;
  var permitSubmissionMessage = null;
  var refreshReadinessButton = null;

  var permitSubmissionPending = false;
  var readinessRefreshPending = false;

  var MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

  var allowedDocumentMimeTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

  /* ---------- Display permit submission messages ---------- */

  function showSubmissionMessage(message, isError) {
    if (!permitSubmissionMessage) return;

    permitSubmissionMessage.textContent = message;

    permitSubmissionMessage.className = "alert " + (isError ? "alert-danger" : "alert-success");

    permitSubmissionMessage.setAttribute("role", "alert");
  }

  /* ---------- Clear permit submission messages ---------- */

  function clearSubmissionMessage() {
    if (!permitSubmissionMessage) return;

    permitSubmissionMessage.textContent = "";
    permitSubmissionMessage.className = "alert d-none";
  }

  /* ---------- Permit submission button state ---------- */

  function setPermitSubmissionPending(isPending) {
    permitSubmissionPending = isPending;

    if (!permitSubmitButton) return;

    permitSubmitButton.disabled = isPending || !String(permitRequirementInput?.value || "").trim();

    if (isPending) {
      permitSubmitButton.setAttribute("data-kt-indicator", "on");
    } else {
      permitSubmitButton.removeAttribute("data-kt-indicator");
    }
  }

  /* ---------- Validate permit document ---------- */

  function validatePermitDocument(file) {
    if (!file) {
      return "Please select a supporting permit document.";
    }

    var fileName = String(file.name || "").trim();
    var mimeType = String(file.type || "").toLowerCase();

    if (!/\.(pdf|jpg|jpeg|png|webp)$/i.test(fileName)) {
      return "Only PDF, JPG, JPEG, PNG and WebP documents are supported.";
    }

    if (mimeType && !allowedDocumentMimeTypes.includes(mimeType)) {
      return "The selected document has an unsupported file type.";
    }

    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return "Please select a valid, non-empty document.";
    }

    if (file.size > MAX_DOCUMENT_BYTES) {
      return "The selected document exceeds the maximum size of 10 MB.";
    }

    return null;
  }

  /* ---------- Validate permit submission ---------- */

  function validatePermitSubmission() {
    if (!permitForm) {
      return "The permit submission form is unavailable.";
    }

    var requirementKey = String(permitRequirementInput?.value || "").trim();

    var permitNumber = String(permitForm.elements.permitNumber?.value || "").trim();

    var permitDescription = String(permitForm.elements.permitDescription?.value || "").trim();

    var documentInput = permitForm.elements.permitDocument;

    var documentFile = documentInput?.files?.[0];

    if (!requirementKey) {
      return "Please select a permit requirement.";
    }

    if (!permitNumber) {
      return "Please enter the permit or licence number.";
    }

    if (permitNumber.length > 120) {
      return "The permit number cannot exceed 120 characters.";
    }

    if (permitDescription.length > 300) {
      return "The permit description cannot exceed 300 characters.";
    }

    return validatePermitDocument(documentFile);
  }

  /* ---------- Select permit requirement ---------- */

  function handlePermitRequirementSelection() {
    if (!permitPage || !permitForm) return;

    document.querySelectorAll(".js-select-permit-requirement").forEach(function (button) {
      button.addEventListener("click", function () {
        if (permitSubmissionPending) return;

        var requirementKey = String(button.getAttribute("data-requirement-key") || "").trim();

        var requirementLabel = String(button.getAttribute("data-requirement-label") || "").trim();

        if (!permitRequirementInput || !permitRequirementLabel) return;

        permitRequirementInput.value = requirementKey;
        permitRequirementLabel.value = requirementLabel;

        clearSubmissionMessage();
        setPermitSubmissionPending(false);

        var submissionCard = document.querySelector("#branchPermitSubmissionCard");

        if (submissionCard) {
          submissionCard.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      });
    });
  }

  /* ---------- Submit facility permit ---------- */

  function handlePermitSubmission() {
    if (!permitForm || !permitSubmitButton) return;

    permitForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (permitSubmissionPending || permitSubmitButton.disabled) return;

      clearSubmissionMessage();

      var validationError = validatePermitSubmission();

      if (validationError) {
        showSubmissionMessage(validationError, true);
        return;
      }

      var csrfInput = permitForm.querySelector('input[name="_csrf"]');

      var csrfToken = String(csrfInput?.value || "").trim();

      if (!csrfToken) {
        showSubmissionMessage("Security token unavailable. Refresh the page and try again.", true);
        return;
      }

      var submissionUrl = String(permitPage.getAttribute("data-submit-url") || "").trim();

      if (!submissionUrl) {
        showSubmissionMessage("The facility permit submission endpoint is unavailable.", true);
        return;
      }

      var formData = new FormData(permitForm);

      setPermitSubmissionPending(true);

      // Keep FormData intact so Axios sets the multipart boundary.
      // Server middleware independently validates the private upload.
      axios
        .post(submissionUrl, formData, {
          headers: {
            Accept: "application/json",
            "CSRF-Token": csrfToken,
          },
        })
        .then(function (response) {
          if (!response.data || response.data.success !== true) {
            throw new Error(response.data?.message || "Unable to submit the facility permit.");
          }

          return Swal.fire({
            text:
              response.data.message ||
              "Facility permit submitted successfully for administrative review.",

            icon: "success",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",

            customClass: {
              confirmButton: "btn btn-primary",
            },
          }).then(function () {
            window.location.reload();
          });
        })
        .catch(function (error) {
          var errorMessage =
            error.response?.data?.message ||
            error.message ||
            "Unable to submit the facility permit. Please try again.";

          showSubmissionMessage(errorMessage, true);

          Swal.fire({
            text: errorMessage,
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",

            customClass: {
              confirmButton: "btn btn-primary",
            },
          });

          setPermitSubmissionPending(false);
        });
    });
  }

  /* ---------- Refresh branch regulatory readiness ---------- */

  function handleReadinessRefresh() {
    if (!permitPage || !refreshReadinessButton) return;

    refreshReadinessButton.addEventListener("click", function () {
      if (readinessRefreshPending || permitSubmissionPending) return;

      var readinessUrl = String(permitPage.getAttribute("data-readiness-url") || "").trim();

      if (!readinessUrl) {
        Swal.fire({
          text: "The branch readiness endpoint is unavailable.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",

          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        return;
      }

      readinessRefreshPending = true;
      refreshReadinessButton.disabled = true;
      refreshReadinessButton.setAttribute("data-kt-indicator", "on");

      axios
        .get(readinessUrl, {
          headers: {
            Accept: "application/json",
          },
        })
        .then(function (response) {
          if (!response.data || response.data.success !== true) {
            throw new Error(response.data?.message || "Unable to refresh branch readiness.");
          }

          // Reload the server-rendered page to update requirements,
          // readiness indicators and permit history together.
          window.location.reload();
        })
        .catch(function (error) {
          readinessRefreshPending = false;

          refreshReadinessButton.disabled = false;
          refreshReadinessButton.removeAttribute("data-kt-indicator");

          Swal.fire({
            text:
              error.response?.data?.message ||
              error.message ||
              "Unable to refresh branch permit status.",

            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",

            customClass: {
              confirmButton: "btn btn-primary",
            },
          });
        });
    });
  }

  /* ---------- Initialise facility permit management ---------- */

  function initialisePermitManagement() {
    permitPage = document.querySelector("#branchPermitPage");

    if (!permitPage) return;

    permitForm = document.querySelector("#branchPermitSubmissionForm");

    permitSubmitButton = document.querySelector("#branchPermitSubmitButton");

    permitRequirementInput = document.querySelector("#selectedPermitRequirementKey");

    permitRequirementLabel = document.querySelector("#selectedPermitRequirementLabel");

    permitSubmissionMessage = document.querySelector("#branchPermitSubmissionMessage");

    refreshReadinessButton = document.querySelector("#refreshBranchPermitReadiness");

    handlePermitRequirementSelection();
    handlePermitSubmission();
    handleReadinessRefresh();

    setPermitSubmissionPending(false);
  }

  return {
    init: function () {
      initialisePermitManagement();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerBranchPermits.init();
});
