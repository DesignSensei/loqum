// public/js/admin/professional-verifications.js

"use strict";

var AdminProfessionalVerifications = (function () {
  var root = null;
  var elements = {};
  var csrfToken = "";

  var summaryUrl = "/admin/professional-verifications/summary";
  var queueUrl = "/admin/professional-verifications/data";
  var professionalBaseUrl = "/admin/professionals";
  var attemptBaseUrl = "/admin/professional-verifications/attempts";

  var PAGE_SIZE = 20;

  var state = {
    page: 1,
    totalPages: 1,
    filter: "awaiting_review",
    type: "",
    search: "",
    queueRequestId: 0,
    detailsRequestId: 0,
    attemptRequestId: 0,
    selectedId: null,
    selected: null,
    actionPending: false,
  };

  // ───────────────────── ELEMENTS ─────────────────────

  function getElement(id) {
    return document.getElementById(id);
  }

  function initializeElements() {
    var ids = {
      feedback: "professionalVerificationFeedback",
      awaitingCount: "professionalAwaitingCount",
      licenceReviewCount: "professionalLicenceReviewCount",
      readyCount: "professionalReadyCount",
      approvedCount: "professionalApprovedCount",
      refresh: "refreshProfessionalQueue",
      statusFilter: "professionalStatusFilter",
      typeFilter: "professionalTypeFilter",
      searchInput: "professionalVerificationSearch",
      searchButton: "professionalSearchButton",
      queueCount: "professionalQueueCount",
      queueLoading: "professionalQueueLoading",
      queueEmpty: "professionalQueueEmpty",
      queueItems: "professionalQueueItems",
      previousPage: "professionalPreviousPage",
      nextPage: "professionalNextPage",
      pageLabel: "professionalPageLabel",
      noSelection: "professionalNoSelection",
      detailsLoading: "professionalDetailsLoading",
      detailsContent: "professionalDetailsContent",
      selectedProfileId: "selectedProfessionalProfileId",
      detailsType: "professionalDetailsType",
      detailsSpecialty: "professionalDetailsSpecialty",
      accountStatus: "professionalAccountStatus",
      approvalStatus: "professionalApprovalStatus",
      ninStatus: "professionalNINStatus",
      ninName: "professionalNINName",
      ninProvider: "professionalNINProvider",
      ninCheckedAt: "professionalNINCheckedAt",
      ninAcknowledgement: "professionalNINAcknowledgement",
      licenceStatus: "professionalLicenceStatus",
      licenceNumber: "professionalLicenceNumber",
      licenceIssuer: "professionalLicenceIssuer",
      licenceName: "professionalLicenceName",
      licenceValidityType: "professionalLicenceValidityType",
      licenceYear: "professionalLicenceYear",
      licenceExpiry: "professionalLicenceExpiry",
      licenceVerifiedAt: "professionalLicenceVerifiedAt",
      licenceValidityNotice: "professionalLicenceValidityNotice",
      licenceReviewNote: "professionalLicenceReviewNote",
      pendingLink: "professionalPendingDocumentLink",
      currentLink: "professionalCurrentDocumentLink",
      upcomingLink: "professionalUpcomingDocumentLink",
      pendingNote: "professionalPendingDocumentNote",
      upcomingSection: "professionalUpcomingLicenceSection",
      upcomingValidFrom: "professionalUpcomingValidFrom",
      upcomingExpiry: "professionalUpcomingExpiry",
      upcomingName: "professionalUpcomingName",
      licenceReviewSection: "professionalLicenceReviewSection",
      licenceForm: "professionalLicenceReviewForm",
      licenceDecision: "professionalLicenceDecision",
      licenceApprovalFields: "professionalLicenceApprovalFields",
      holderName: "professionalLicenceHolderName",
      validityType: "professionalLicenceValiditySelection",
      expiryGroup: "professionalLicenceExpiryGroup",
      expiryDate: "professionalLicenceExpiryInput",
      yearGroup: "professionalLicenceYearGroup",
      licensingYear: "professionalLicenceYearInput",
      councilReviewed: "professionalCouncilReviewed",
      councilSourceGroup: "professionalCouncilSourceGroup",
      councilSource: "professionalCouncilSource",
      licenceNote: "professionalLicenceNote",
      licenceSubmit: "professionalLicenceReviewSubmit",
      approvalSection: "professionalApprovalSection",
      approvalReadinessNotice: "professionalApprovalReadinessNotice",
      approvalForm: "professionalApprovalForm",
      approvalDecision: "professionalApprovalDecision",
      approvalNote: "professionalApprovalNote",
      approvalSubmit: "professionalApprovalSubmit",
      historyBody: "professionalVerificationHistoryBody",
      attemptEvidence: "professionalAttemptEvidence",
    };

    Object.keys(ids).forEach(function (key) {
      elements[key] = getElement(ids[key]);
    });
  }

  // ───────────────────── DISPLAY HELPERS ─────────────────────

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function setText(element, value, fallback) {
    if (element) element.textContent = clean(value) || fallback || "-";
  }

  function formatStatus(value) {
    return clean(value)
      .replace(/[_:-]/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function badgeClass(status) {
    var classes = {
      verified: "badge-light-success",
      approved: "badge-light-success",
      active: "badge-light-success",
      pending: "badge-light-warning",
      awaiting_review: "badge-light-warning",
      needs_review: "badge-light-warning",
      expired: "badge-light-warning",
      rejected: "badge-light-danger",
      restricted: "badge-light-danger",
      suspended: "badge-light-danger",
      banned: "badge-light-danger",
    };

    return classes[status] || "badge-light-secondary";
  }

  function setBadge(element, status, label) {
    if (!element) return;

    var normalized = clean(status || "pending").toLowerCase();

    element.className = "badge " + badgeClass(normalized);
    element.textContent = label || formatStatus(normalized);
  }

  function createElement(tag, className, value) {
    var element = document.createElement(tag);

    if (className) element.className = className;
    if (value != null) element.textContent = String(value);

    return element;
  }

  function createBadge(status, label) {
    var element = createElement("span");
    setBadge(element, status, label);
    return element;
  }

  function formatDate(value) {
    if (!value) return "-";

    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";

    return date.toLocaleString("en-NG", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDateOnly(value) {
    if (!value) return "-";

    var text = clean(value);

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return text;
    }

    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";

    return date.toLocaleDateString("en-GB", {
      timeZone: "Africa/Lagos",
    });
  }

  function formatValidityType(type) {
    var labels = {
      expiry_date: "Specified Expiry Date",
      licensing_year: "Approved Licensing Year",
      life: "Confirmed Life Licence",
    };

    return labels[type] || "Not recorded";
  }

  function showFeedback(message, type) {
    if (!elements.feedback) return;

    var allowed = ["success", "danger", "warning", "info"];
    var style = allowed.includes(type) ? type : "info";

    elements.feedback.className = "alert alert-" + style + " mb-6";
    elements.feedback.textContent = message;
  }

  function clearFeedback() {
    if (!elements.feedback) return;

    elements.feedback.className = "alert alert-info d-none mb-6";
    elements.feedback.textContent = "";
  }

  function errorMessage(error, fallback) {
    return error?.response?.data?.message || error?.message || fallback;
  }

  function notify(message, icon) {
    return Swal.fire({
      text: message,
      icon: icon || "info",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function confirmAction(message, label, danger) {
    return Swal.fire({
      text: message,
      icon: danger ? "warning" : "question",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: label,
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: danger ? "btn btn-danger" : "btn btn-primary",
        cancelButton: "btn btn-light",
      },
    });
  }

  // ───────────────────── API HELPERS ─────────────────────

  function apiGet(url) {
    return axios
      .get(url, {
        withCredentials: true,
        headers: {
          Accept: "application/json",
        },
      })
      .then(function (response) {
        if (response.data?.success !== true) {
          throw new Error("Unable to load professional verification data.");
        }

        return response.data;
      });
  }

  function apiPost(url, payload) {
    if (!csrfToken) {
      return Promise.reject(new Error("Security token unavailable. Refresh the page."));
    }

    return axios
      .post(url, payload, {
        withCredentials: true,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "CSRF-Token": csrfToken,
        },
      })
      .then(function (response) {
        if (response.data?.success !== true) {
          throw new Error("Unable to save the verification decision.");
        }

        return response.data;
      });
  }

  function validObjectId(value) {
    return /^[a-f0-9]{24}$/i.test(clean(value));
  }

  function professionalUrl(profileId, suffix) {
    if (!validObjectId(profileId)) return "";

    return (
      professionalBaseUrl + "/" + encodeURIComponent(profileId) + "/verification" + (suffix || "")
    );
  }

  function attemptUrl(verificationId) {
    if (!validObjectId(verificationId)) return "";

    return attemptBaseUrl + "/" + encodeURIComponent(verificationId);
  }

  // ───────────────────── ACTION STATE ─────────────────────

  function setActionPending(pending) {
    state.actionPending = pending;

    [
      elements.refresh,
      elements.statusFilter,
      elements.typeFilter,
      elements.searchInput,
      elements.searchButton,
      elements.previousPage,
      elements.nextPage,
    ].forEach(function (element) {
      if (element) element.disabled = pending;
    });

    [elements.licenceSubmit, elements.approvalSubmit].forEach(function (button) {
      if (!button) return;

      if (pending) button.setAttribute("data-kt-indicator", "on");
      else button.removeAttribute("data-kt-indicator");
    });

    updateReviewControls();
    updatePagination();
  }

  // ───────────────────── DASHBOARD SUMMARY ─────────────────────

  function loadSummary() {
    return apiGet(summaryUrl)
      .then(function (response) {
        var stats = response.data?.stats || {};

        setText(elements.awaitingCount, stats.awaitingReview, "0");
        setText(elements.licenceReviewCount, stats.licenceReview, "0");
        setText(elements.readyCount, stats.readyForApproval, "0");
        setText(elements.approvedCount, stats.approved, "0");
      })
      .catch(function () {
        // Keep the counts rendered by the server.
      });
  }

  // ───────────────────── VERIFICATION QUEUE ─────────────────────

  function updatePagination(pagination) {
    if (pagination) {
      state.totalPages = Math.max(1, Number(pagination.totalPages) || 1);
      setText(elements.queueCount, String(Number(pagination.total) || 0) + " professionals found");
    }

    setText(elements.pageLabel, "Page " + state.page + " of " + state.totalPages);

    if (elements.previousPage) {
      elements.previousPage.disabled = state.actionPending || state.page <= 1;
    }

    if (elements.nextPage) {
      elements.nextPage.disabled = state.actionPending || state.page >= state.totalPages;
    }
  }

  function highlightSelection() {
    elements.queueItems?.querySelectorAll("[data-professional-id]").forEach(function (item) {
      var selected = item.dataset.professionalId === state.selectedId;

      item.classList.toggle("border-primary", selected);
      item.classList.toggle("bg-light-primary", selected);
    });
  }

  function clearSelection() {
    state.selectedId = null;
    state.selected = null;
    state.detailsRequestId += 1;
    state.attemptRequestId += 1;

    if (elements.selectedProfileId) {
      elements.selectedProfileId.value = "";
    }

    elements.noSelection?.classList.remove("d-none");
    elements.detailsLoading?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");

    if (elements.attemptEvidence) {
      elements.attemptEvidence.replaceChildren();
      elements.attemptEvidence.classList.add("d-none");
    }

    disableDocumentLink(elements.pendingLink);
    disableDocumentLink(elements.currentLink);
    disableDocumentLink(elements.upcomingLink);

    highlightSelection();
  }

  function renderQueue(professionals) {
    if (!elements.queueItems) return;

    elements.queueItems.replaceChildren();
    elements.queueEmpty?.classList.toggle("d-none", professionals.length !== 0);

    professionals.forEach(function (professional) {
      var id = clean(professional.professionalProfileId);

      if (!validObjectId(id)) return;

      var item = createElement("button", "btn btn-light text-start w-100 border p-4");

      item.type = "button";
      item.dataset.professionalId = id;

      var heading = createElement(
        "div",
        "d-flex justify-content-between align-items-center gap-2 mb-2"
      );

      heading.append(
        createElement(
          "span",
          "fw-bold text-gray-900",
          formatStatus(professional.professionalType) || "Professional"
        ),
        createBadge(professional.professionalApprovalStatus)
      );

      item.appendChild(heading);

      item.appendChild(
        createElement(
          "div",
          "text-gray-700 fs-7 mb-2",
          professional.specialty || professional.licenceIssuingBody || "No specialty recorded"
        )
      );

      var details = createElement("div", "d-flex flex-wrap gap-2 align-items-center");

      details.appendChild(createBadge(professional.licenceVerificationStatus));

      if (professional.licencePendingDocumentSubmittedAt) {
        details.appendChild(
          createElement("span", "badge badge-light-warning", "Licence submitted")
        );
      }

      if (professional.verificationReadiness?.readyForApproval === true) {
        details.appendChild(
          createElement("span", "badge badge-light-success", "Ready for approval")
        );
      }

      item.appendChild(details);

      item.addEventListener("click", function () {
        if (!state.actionPending) selectProfessional(id);
      });

      elements.queueItems.appendChild(item);
    });

    highlightSelection();
  }

  function loadQueue() {
    var requestId = ++state.queueRequestId;

    var params = new URLSearchParams({
      status: state.filter,
      page: String(state.page),
      limit: String(PAGE_SIZE),
    });

    if (state.type) params.set("type", state.type);
    if (state.search) params.set("search", state.search);

    elements.queueLoading?.classList.remove("d-none");

    return apiGet(queueUrl + "?" + params.toString())
      .then(function (response) {
        if (requestId !== state.queueRequestId) return;

        renderQueue(Array.isArray(response.data) ? response.data : []);
        updatePagination(response.pagination || {});
      })
      .catch(function (error) {
        if (requestId !== state.queueRequestId) return;

        renderQueue([]);
        setText(elements.queueCount, "Unable to load professionals");
        showFeedback(errorMessage(error, "Unable to load verification queue."), "danger");
      })
      .finally(function () {
        if (requestId === state.queueRequestId) {
          elements.queueLoading?.classList.add("d-none");
        }
      });
  }

  // ───────────────────── PRIVATE DOCUMENT LINKS ─────────────────────

  function disableDocumentLink(element) {
    if (!element) return;

    element.removeAttribute("href");
    element.classList.add("disabled");
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("tabindex", "-1");
  }

  function configureDocumentLink(element, profileId, kind, available) {
    disableDocumentLink(element);

    if (!available || !element) return;

    var url = professionalUrl(profileId, "/licence/document?document=" + encodeURIComponent(kind));

    if (!url) return;

    element.href = url;
    element.classList.remove("disabled");
    element.removeAttribute("aria-disabled");
    element.removeAttribute("tabindex");
  }

  // ───────────────────── VERIFICATION DETAILS ─────────────────────

  function renderNINEvidence(data) {
    var evidence = data.ninEvidence || {};
    var readiness = data.verificationReadiness || {};

    var trusted = readiness.trustedNinEvidence === true;

    setBadge(
      elements.ninStatus,
      trusted ? "verified" : "needs_review",
      trusted ? "Trusted Registry Evidence" : "Evidence Not Confirmed"
    );

    setText(elements.ninName, evidence.registryLegalName, "Not available");
    setText(elements.ninProvider, evidence.provider, "Not available");
    setText(elements.ninCheckedAt, formatDate(evidence.checkedAt));
    setText(
      elements.ninAcknowledgement,
      evidence.nameAcknowledged === true ? "Registry name acknowledged" : "Not confirmed"
    );
  }

  function renderLicence(data) {
    var licence = data.licenceVerification || {};
    var upcoming = licence.upcomingLicence || null;
    var id = data.professionalProfileId;

    setBadge(elements.licenceStatus, licence.status);
    setText(elements.licenceNumber, licence.licenceNumber);
    setText(elements.licenceIssuer, licence.issuingBody);
    setText(elements.licenceName, licence.nameOnRecord, "Not yet reviewed");
    setText(elements.licenceValidityType, formatValidityType(licence.validityType));
    setText(elements.licenceYear, licence.licensingYear);
    setText(
      elements.licenceExpiry,
      licence.validityType === "life" ? "No fixed expiry" : formatDateOnly(licence.expiryDate)
    );
    setText(elements.licenceVerifiedAt, formatDate(licence.verifiedAt));

    var validityMessage = "Licence validity has not been confirmed.";

    if (licence.status === "verified") {
      if (licence.expired === true) {
        validityMessage =
          licence.withinGrace === true
            ? "The recorded licence has expired. Platform renewal grace runs until " +
              formatDateOnly(licence.graceEndsOn) +
              ". This does not authorize expired clinical practice."
            : "The recorded licence has expired. New clinical assignments require valid authorization.";
      } else {
        validityMessage =
          licence.validityType === "life"
            ? "A life licence has been recorded following administrative review."
            : "The verified licence is recorded as current.";
      }
    }

    setText(elements.licenceValidityNotice, validityMessage);
    setText(
      elements.licenceReviewNote,
      licence.note ? "Last review note: " + licence.note : "No review note recorded."
    );

    configureDocumentLink(
      elements.pendingLink,
      id,
      "pending",
      licence.pendingDocumentAvailable === true
    );

    configureDocumentLink(elements.currentLink, id, "current", licence.documentAvailable === true);

    configureDocumentLink(
      elements.upcomingLink,
      id,
      "upcoming",
      upcoming?.documentAvailable === true
    );

    setText(
      elements.pendingNote,
      licence.pendingDocumentAvailable === true
        ? "Pending document submitted: " + formatDate(licence.pendingDocumentSubmittedAt)
        : "No new practising-licence document is awaiting review."
    );

    elements.upcomingSection?.classList.toggle("d-none", !upcoming);

    if (upcoming) {
      setText(elements.upcomingValidFrom, formatDateOnly(upcoming.validFrom));
      setText(
        elements.upcomingExpiry,
        upcoming.validityType === "life" ? "No fixed expiry" : formatDateOnly(upcoming.expiryDate)
      );
      setText(elements.upcomingName, upcoming.nameOnRecord);
    }
  }

  function renderHistory(history) {
    if (!elements.historyBody) return;

    elements.historyBody.replaceChildren();

    var attempts = Array.isArray(history?.attempts) ? history.attempts : [];

    if (!attempts.length) {
      var emptyRow = createElement("tr");
      var emptyCell = createElement(
        "td",
        "text-center text-muted py-6",
        "No verification history available."
      );

      emptyCell.colSpan = 4;
      emptyRow.appendChild(emptyCell);
      elements.historyBody.appendChild(emptyRow);
      return;
    }

    attempts.forEach(function (attempt) {
      var row = createElement("tr");

      row.appendChild(createElement("td", "fw-semibold", formatStatus(attempt.type)));

      var statusCell = createElement("td");
      statusCell.appendChild(createBadge(attempt.status));
      row.appendChild(statusCell);

      row.appendChild(
        createElement(
          "td",
          "text-gray-600 fs-7",
          formatDate(attempt.lastCheckedAt || attempt.createdAt)
        )
      );

      var actionCell = createElement("td");
      var button = createElement("button", "btn btn-sm btn-light-primary", "View");

      button.type = "button";

      button.addEventListener("click", function () {
        if (!state.actionPending) {
          viewAttempt(attempt.verificationId);
        }
      });

      actionCell.appendChild(button);
      row.appendChild(actionCell);
      elements.historyBody.appendChild(row);
    });
  }

  function renderDetails(data) {
    state.selected = data;

    setText(elements.detailsType, formatStatus(data.professionalType));
    setText(elements.detailsSpecialty, data.specialty, "No specialty recorded");
    setBadge(elements.accountStatus, data.accountStatus);
    setBadge(elements.approvalStatus, data.professionalApproval?.status);

    renderNINEvidence(data);
    renderLicence(data);
    renderHistory(data.verificationHistory);

    elements.licenceForm?.reset();
    elements.approvalForm?.reset();

    if (elements.attemptEvidence) {
      elements.attemptEvidence.replaceChildren();
      elements.attemptEvidence.classList.add("d-none");
    }

    updateReviewControls();
  }

  function selectProfessional(id) {
    if (!validObjectId(id) || state.actionPending) return;

    var requestId = ++state.detailsRequestId;

    state.selectedId = id;
    state.selected = null;

    if (elements.selectedProfileId) {
      elements.selectedProfileId.value = id;
    }

    clearFeedback();
    highlightSelection();

    elements.noSelection?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");
    elements.detailsLoading?.classList.remove("d-none");

    disableDocumentLink(elements.pendingLink);
    disableDocumentLink(elements.currentLink);
    disableDocumentLink(elements.upcomingLink);

    return apiGet(professionalUrl(id))
      .then(function (response) {
        if (requestId !== state.detailsRequestId || state.selectedId !== id) {
          return;
        }

        renderDetails(response.data || {});
        elements.detailsContent?.classList.remove("d-none");
      })
      .catch(function (error) {
        if (requestId !== state.detailsRequestId) return;

        elements.noSelection?.classList.remove("d-none");
        showFeedback(
          errorMessage(error, "Unable to load professional verification details."),
          "danger"
        );
      })
      .finally(function () {
        if (requestId === state.detailsRequestId) {
          elements.detailsLoading?.classList.add("d-none");
        }
      });
  }

  // ───────────────────── VERIFICATION HISTORY DETAIL ─────────────────────

  function viewAttempt(verificationId) {
    var url = attemptUrl(verificationId);
    var selectedId = state.selectedId;

    if (!url || !selectedId || !elements.attemptEvidence) return;

    var requestId = ++state.attemptRequestId;

    elements.attemptEvidence.classList.remove("d-none");
    setText(elements.attemptEvidence, "Loading verification evidence...");

    return apiGet(url)
      .then(function (response) {
        if (requestId !== state.attemptRequestId || state.selectedId !== selectedId) {
          return;
        }

        var attempt = response.data || {};
        var evidence = attempt.evidence || {};
        var container = elements.attemptEvidence;

        container.replaceChildren();

        container.appendChild(
          createElement("h6", "fw-bold mb-4", formatStatus(attempt.type) + " Verification Evidence")
        );

        var rows = [
          ["Status", formatStatus(attempt.status)],
          ["Provider", attempt.provider],
          ["Environment", attempt.environment],
          ["Registered Name", attempt.nameOnRecord],
          ["Checked", formatDate(attempt.lastCheckedAt)],
          ["Review Note", attempt.reviewNote],
          ["Registry Found", String(evidence.registryFound ?? "Not recorded")],
          ["Registry Matched", String(evidence.registryMatched ?? "Not recorded")],
          ["Document Reviewed", String(evidence.documentReviewed ?? "Not recorded")],
          ["Council Reviewed", String(evidence.councilReviewed ?? "Not recorded")],
          ["Council Source", evidence.councilSource],
          ["Validity Type", evidence.validityType],
          ["Licensing Year", evidence.licensingYear],
          ["Expiry Date", evidence.expiryDate],
        ];

        rows.forEach(function (entry) {
          var row = createElement("div", "d-flex flex-wrap justify-content-between gap-3 mb-3");

          row.append(
            createElement("span", "text-muted fw-semibold", entry[0]),
            createElement("span", "fw-semibold text-break", entry[1] || "-")
          );

          container.appendChild(row);
        });
      })
      .catch(function (error) {
        if (requestId !== state.attemptRequestId) return;

        setText(
          elements.attemptEvidence,
          errorMessage(error, "Unable to load verification evidence.")
        );
      });
  }

  // ───────────────────── REVIEW CONTROLS ─────────────────────

  function updateReviewControls() {
    var data = state.selected || {};
    var licence = data.licenceVerification || {};
    var approvalStatus = clean(data.professionalApproval?.status);

    var hasPendingDocument = licence.pendingDocumentAvailable === true;
    var licenceVerifiedDecision = elements.licenceDecision?.value === "verified";
    var validityType = elements.validityType?.value;
    var councilChecked = elements.councilReviewed?.checked === true;

    elements.licenceReviewSection?.classList.toggle("d-none", !hasPendingDocument);

    elements.licenceApprovalFields?.classList.toggle(
      "d-none",
      !hasPendingDocument || !licenceVerifiedDecision
    );

    elements.expiryGroup?.classList.toggle(
      "d-none",
      !licenceVerifiedDecision || validityType !== "expiry_date"
    );

    elements.yearGroup?.classList.toggle(
      "d-none",
      !licenceVerifiedDecision || validityType !== "licensing_year"
    );

    elements.councilSourceGroup?.classList.toggle(
      "d-none",
      !licenceVerifiedDecision || !councilChecked
    );

    [elements.licenceDecision, elements.licenceNote].forEach(function (element) {
      if (element) {
        element.disabled = state.actionPending || !hasPendingDocument;
      }
    });

    [elements.holderName, elements.validityType, elements.councilReviewed].forEach(
      function (element) {
        if (element) {
          element.disabled = state.actionPending || !hasPendingDocument || !licenceVerifiedDecision;
        }
      }
    );

    if (elements.expiryDate) {
      elements.expiryDate.disabled =
        state.actionPending || !licenceVerifiedDecision || validityType !== "expiry_date";
    }

    if (elements.licensingYear) {
      elements.licensingYear.disabled =
        state.actionPending || !licenceVerifiedDecision || validityType !== "licensing_year";
    }

    if (elements.councilSource) {
      elements.councilSource.disabled =
        state.actionPending || !licenceVerifiedDecision || !councilChecked;
    }

    if (elements.licenceSubmit) {
      elements.licenceSubmit.disabled = state.actionPending || !hasPendingDocument;
    }

    var canReviewApproval = ["pending", "needs_review"].includes(approvalStatus);
    var ready = data.verificationReadiness?.readyForApproval === true;

    elements.approvalSection?.classList.toggle("d-none", !canReviewApproval);

    setText(
      elements.approvalReadinessNotice,
      ready
        ? "Trusted NIN evidence and the verified current practising licence have passed readiness checks."
        : "Final approval is not yet available. Resolve outstanding verification evidence or licence validity issues. You may record a further-review or rejection decision where appropriate."
    );

    if (elements.approvalDecision) {
      elements.approvalDecision.disabled = state.actionPending || !canReviewApproval;

      var approveOption = elements.approvalDecision.querySelector('option[value="approved"]');

      if (approveOption) approveOption.disabled = !ready;

      if (!ready && elements.approvalDecision.value === "approved") {
        elements.approvalDecision.value = "";
      }
    }

    if (elements.approvalNote) {
      elements.approvalNote.disabled = state.actionPending || !canReviewApproval;
    }

    if (elements.approvalSubmit) {
      elements.approvalSubmit.disabled = state.actionPending || !canReviewApproval;
    }
  }

  // ───────────────────── LICENCE REVIEW ─────────────────────

  function getLicenceReviewPayload() {
    var decision = clean(elements.licenceDecision?.value);
    var note = clean(elements.licenceNote?.value);

    if (!["verified", "needs_review", "rejected"].includes(decision)) {
      throw new Error("Select a valid practising-licence decision.");
    }

    if (note.length < 10 || note.length > 1000) {
      throw new Error("Enter a meaningful review note of 10–1,000 characters.");
    }

    var payload = {
      decision: decision,
      note: note,
      nameOnRecord: null,
      validityType: null,
      expiryDate: null,
      licensingYear: null,
      councilReviewed: false,
      councilSource: null,
    };

    if (decision !== "verified") return payload;

    var name = clean(elements.holderName?.value);
    var validityType = clean(elements.validityType?.value);

    if (!name || name.length > 150 || /[\u0000-\u001F\u007F]/.test(name)) {
      throw new Error("Enter the valid licence-holder name from the reviewed evidence.");
    }

    if (!["expiry_date", "licensing_year", "life"].includes(validityType)) {
      throw new Error("Select the verified practising-licence validity type.");
    }

    payload.nameOnRecord = name;
    payload.validityType = validityType;

    if (validityType === "expiry_date") {
      payload.expiryDate = clean(elements.expiryDate?.value);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.expiryDate)) {
        throw new Error("Select the verified expiry date.");
      }
    }

    if (validityType === "licensing_year") {
      var year = clean(elements.licensingYear?.value);

      if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2199) {
        throw new Error("Enter a valid four-digit licensing year.");
      }

      payload.licensingYear = Number(year);
    }

    payload.councilReviewed = elements.councilReviewed?.checked === true;

    if (payload.councilReviewed) {
      payload.councilSource = clean(elements.councilSource?.value);

      if (payload.councilSource.length < 3 || payload.councilSource.length > 150) {
        throw new Error("Record the council source actually checked.");
      }
    }

    return payload;
  }

  async function handleLicenceReview(event) {
    event.preventDefault();

    var data = state.selected;
    var profileId = state.selectedId;

    if (
      !data ||
      !profileId ||
      state.actionPending ||
      data.licenceVerification?.pendingDocumentAvailable !== true
    ) {
      return;
    }

    var payload;

    try {
      payload = getLicenceReviewPayload();
    } catch (error) {
      await notify(error.message, "warning");
      return;
    }

    var confirmation = await confirmAction(
      "Record this practising licence as " + formatStatus(payload.decision) + "?",
      "Save Licence Review",
      payload.decision === "rejected"
    );

    if (!confirmation.isConfirmed || state.actionPending || state.selectedId !== profileId) {
      return;
    }

    setActionPending(true);

    try {
      await apiPost(professionalUrl(profileId, "/licence/review"), payload);

      clearSelection();
      await Promise.all([loadQueue(), loadSummary()]);
      showFeedback("Practising-licence review saved successfully.", "success");
    } catch (error) {
      await notify(errorMessage(error, "Unable to save licence review."), "error");
    } finally {
      setActionPending(false);
    }
  }

  // ───────────────────── FINAL APPROVAL ─────────────────────

  async function handleApprovalReview(event) {
    event.preventDefault();

    var data = state.selected;
    var profileId = state.selectedId;

    if (!data || !profileId || state.actionPending) return;

    var status = clean(data.professionalApproval?.status);

    if (!["pending", "needs_review"].includes(status)) return;

    var decision = clean(elements.approvalDecision?.value);
    var note = clean(elements.approvalNote?.value);

    if (!["approved", "needs_review", "rejected"].includes(decision)) {
      await notify("Select a valid professional approval decision.", "warning");
      return;
    }

    if (decision === "approved" && data.verificationReadiness?.readyForApproval !== true) {
      await notify("The professional has not passed final approval readiness checks.", "warning");
      return;
    }

    if (note.length < 10 || note.length > 1000) {
      await notify("Enter a meaningful decision note of 10–1,000 characters.", "warning");
      return;
    }

    var confirmation = await confirmAction(
      "Record the final professional decision as " + formatStatus(decision) + "?",
      "Save Decision",
      decision === "rejected"
    );

    if (!confirmation.isConfirmed || state.actionPending || state.selectedId !== profileId) {
      return;
    }

    setActionPending(true);

    try {
      await apiPost(professionalUrl(profileId, "/approval/review"), {
        decision: decision,
        note: note,
      });

      clearSelection();
      await Promise.all([loadQueue(), loadSummary()]);
      showFeedback("Professional approval decision saved successfully.", "success");
    } catch (error) {
      await notify(errorMessage(error, "Unable to save final approval."), "error");
    } finally {
      setActionPending(false);
    }
  }

  // ───────────────────── EVENTS ─────────────────────

  function applyFilters() {
    if (state.actionPending) return;

    state.filter = elements.statusFilter?.value || "awaiting_review";
    state.type = elements.typeFilter?.value || "";
    state.search = clean(elements.searchInput?.value);
    state.page = 1;

    clearSelection();
    clearFeedback();
    loadQueue();
  }

  function attachEvents() {
    elements.refresh?.addEventListener("click", function () {
      if (state.actionPending) return;
      clearFeedback();
      loadQueue();
      loadSummary();
    });

    elements.statusFilter?.addEventListener("change", applyFilters);
    elements.typeFilter?.addEventListener("change", applyFilters);
    elements.searchButton?.addEventListener("click", applyFilters);

    elements.searchInput?.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        applyFilters();
      }
    });

    elements.previousPage?.addEventListener("click", function () {
      if (state.actionPending || state.page <= 1) return;

      state.page -= 1;
      clearSelection();
      loadQueue();
    });

    elements.nextPage?.addEventListener("click", function () {
      if (state.actionPending || state.page >= state.totalPages) return;

      state.page += 1;
      clearSelection();
      loadQueue();
    });

    elements.licenceDecision?.addEventListener("change", updateReviewControls);

    elements.validityType?.addEventListener("change", updateReviewControls);

    elements.councilReviewed?.addEventListener("change", updateReviewControls);

    elements.licenceForm?.addEventListener("submit", handleLicenceReview);

    elements.approvalForm?.addEventListener("submit", handleApprovalReview);
  }

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      root = document.querySelector("#adminProfessionalVerifications");

      if (!root) return;

      initializeElements();

      csrfToken =
        root.dataset.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || "";

      summaryUrl = root.dataset.summaryUrl || summaryUrl;
      queueUrl = root.dataset.queueUrl || queueUrl;

      professionalBaseUrl = (root.dataset.professionalBaseUrl || professionalBaseUrl).replace(
        /\/$/,
        ""
      );

      attemptBaseUrl = (root.dataset.attemptBaseUrl || attemptBaseUrl).replace(/\/$/, "");

      state.filter = elements.statusFilter?.value || "awaiting_review";
      state.type = elements.typeFilter?.value || "";
      state.search = "";

      attachEvents();
      clearSelection();
      updatePagination();
      loadQueue();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminProfessionalVerifications.init();
});
