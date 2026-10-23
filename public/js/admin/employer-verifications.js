// public/js/admin/employer-verifications.js

"use strict";

var AdminEmployerVerifications = (function () {
  var root = document.querySelector("#adminEmployerVerifications");

  var elements = {};
  var csrfToken = "";

  var queueUrl = "/admin/employer-verifications/data";
  var employerBaseUrl = "/admin/employers";

  var PAGE_SIZE = 20;

  var state = {
    page: 1,
    totalPages: 1,
    total: 0,
    filter: "review",
    selectedEmployerId: null,
    queueRequestId: 0,
    detailsRequestId: 0,
    actionPending: false,
  };

  // ───────────────────────── ELEMENTS ─────────────────────────

  function getElement(id) {
    return document.querySelector("#" + id);
  }

  function initializeElements() {
    elements = {
      feedback: getElement("verificationFeedback"),

      refreshQueue: getElement("refreshVerificationQueue"),
      statusFilter: getElement("verificationStatusFilter"),
      queueCount: getElement("verificationQueueCount"),
      queueLoading: getElement("verificationQueueLoading"),
      queueEmpty: getElement("verificationQueueEmpty"),
      queueItems: getElement("verificationQueueItems"),

      previousPage: getElement("verificationPreviousPage"),
      nextPage: getElement("verificationNextPage"),
      pageLabel: getElement("verificationPageLabel"),

      noSelection: getElement("verificationNoSelection"),
      detailsLoading: getElement("verificationDetailsLoading"),
      detailsContent: getElement("verificationDetailsContent"),
      selectedEmployerId: getElement("selectedVerificationEmployerId"),

      businessName: getElement("verificationBusinessName"),
      businessType: getElement("verificationBusinessType"),
      accountStatus: getElement("verificationAccountStatus"),

      cacNumber: getElement("verificationCACNumber"),
      regulatoryNumber: getElement("verificationRegulatoryNumber"),
      businessEmail: getElement("verificationBusinessEmail"),
      businessLocation: getElement("verificationBusinessLocation"),

      cacStatus: getElement("verificationCACStatus"),
      cacName: getElement("verificationCACName"),
      cacCheckedAt: getElement("verificationCACCheckedAt"),
      cacNote: getElement("verificationCACNote"),
      cacRecheck: getElement("verificationCACRecheck"),

      pcnSection: getElement("verificationPCNSection"),
      pcnStatus: getElement("verificationPCNStatus"),
      pcnName: getElement("verificationPCNName"),
      pcnForm: getElement("verificationPCNForm"),
      pcnDecision: getElement("verificationPCNDecision"),
      pcnRegisteredName: getElement("verificationPCNRegisteredName"),
      pcnReviewNote: getElement("verificationPCNReviewNote"),
      pcnSubmit: getElement("verificationPCNSubmit"),

      employerApprovalStatus: getElement("verificationEmployerApprovalStatus"),
      employerApprovalNote: getElement("verificationEmployerApprovalNote"),

      historyBody: getElement("verificationHistoryBody"),
    };
  }

  // ───────────────────────── HELPERS ─────────────────────────

  function setText(element, value, fallback) {
    if (!element) return;

    var text = String(value ?? "").trim();

    element.textContent = text || fallback || "-";
  }

  function formatStatus(value) {
    return String(value || "pending")
      .replace(/_/g, " ")
      .replace(/\b\w/g, function (character) {
        return character.toUpperCase();
      });
  }

  function getBadgeClass(status) {
    var classes = {
      verified: "badge-light-success",
      approved: "badge-light-success",
      active: "badge-light-success",

      pending: "badge-light-warning",
      needs_review: "badge-light-warning",
      restricted: "badge-light-warning",
      expired: "badge-light-warning",

      rejected: "badge-light-danger",
      suspended: "badge-light-danger",
      failed: "badge-light-danger",
      banned: "badge-light-danger",
    };

    return classes[status] || "badge-light-secondary";
  }

  function setBadge(element, status) {
    if (!element) return;

    var cleanStatus = String(status || "pending").toLowerCase();

    element.className = "badge " + getBadgeClass(cleanStatus);
    element.textContent = formatStatus(cleanStatus);
  }

  function formatDate(value) {
    if (!value) return "-";

    var date = new Date(value);

    if (isNaN(date.getTime())) {
      return "-";
    }

    return date.toLocaleString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text !== undefined && text !== null) {
      element.textContent = String(text);
    }

    return element;
  }

  function showFeedback(message, type) {
    if (!elements.feedback) return;

    var allowedTypes = ["success", "danger", "warning", "info"];

    var safeType = allowedTypes.includes(type) ? type : "info";

    elements.feedback.className = "alert alert-" + safeType + " mb-5";
    elements.feedback.textContent = message;
    elements.feedback.classList.remove("d-none");
  }

  function clearFeedback() {
    if (!elements.feedback) return;

    elements.feedback.classList.add("d-none");
    elements.feedback.textContent = "";
  }

  function getErrorMessage(error, fallback) {
    return error.response?.data?.message || error.message || fallback;
  }

  function setQueueLoading(loading) {
    elements.queueLoading?.classList.toggle("d-none", !loading);

    if (elements.refreshQueue) {
      elements.refreshQueue.disabled = loading;
    }
  }

  function setDetailsLoading(loading) {
    elements.detailsLoading?.classList.toggle("d-none", !loading);

    if (loading) {
      elements.noSelection?.classList.add("d-none");
      elements.detailsContent?.classList.add("d-none");
    }
  }

  function setActionPending(pending) {
    state.actionPending = pending;

    [
      elements.cacRecheck,
      elements.pcnSubmit,
      elements.pcnDecision,
      elements.pcnRegisteredName,
      elements.pcnReviewNote,
    ].forEach(function (element) {
      if (element) {
        element.disabled = pending;
      }
    });

    if (elements.pcnSubmit) {
      if (pending) {
        elements.pcnSubmit.setAttribute("data-kt-indicator", "on");
      } else {
        elements.pcnSubmit.removeAttribute("data-kt-indicator");
      }
    }
  }

  // ───────────────────────── API HELPERS ─────────────────────────

  function getRequestHeaders(method) {
    var headers = {
      Accept: "application/json",
    };

    if (method !== "GET") {
      if (!csrfToken) {
        throw new Error("Security token unavailable. Please refresh the page.");
      }

      headers["CSRF-Token"] = csrfToken;
      headers["Content-Type"] = "application/json";
    }

    return headers;
  }

  function apiGet(url) {
    return axios.get(url, {
      headers: getRequestHeaders("GET"),
      withCredentials: true,
    });
  }

  function apiPost(url, data) {
    return axios.post(url, data || {}, {
      headers: getRequestHeaders("POST"),
      withCredentials: true,
    });
  }

  function getEmployerUrl(employerId, suffix) {
    return (
      employerBaseUrl + "/" + encodeURIComponent(employerId) + "/verification" + (suffix || "")
    );
  }

  // ───────────────────────── QUEUE DISPLAY ─────────────────────────

  function createStatusBadge(label, status) {
    var badge = createElement("span", "badge");

    setBadge(badge, status);

    badge.prepend(document.createTextNode(label + ": "));

    return badge;
  }

  function createEmployerItem(employer) {
    var employerId = String(employer._id || "");

    var button = createElement("button", "btn btn-light text-start w-100 border p-4");

    button.type = "button";
    button.dataset.employerId = employerId;

    if (state.selectedEmployerId === employerId) {
      button.classList.add("border-primary", "bg-light-primary");
    }

    var heading = createElement(
      "div",
      "d-flex justify-content-between align-items-start gap-2 mb-2"
    );

    var name = createElement(
      "span",
      "fw-bold text-gray-900",
      employer.businessName || "Unnamed Business"
    );

    var accountBadge = createElement("span", "badge");

    setBadge(accountBadge, employer.accountStatus || "active");

    heading.append(name, accountBadge);

    var identity = createElement(
      "div",
      "text-gray-600 fs-7 mb-3",
      formatStatus(employer.type || "business") + " · " + (employer.cacRegistrationNumber || "-")
    );

    var statuses = createElement("div", "d-flex flex-wrap gap-2");

    statuses.append(
      createStatusBadge("CAC", employer.cacVerificationStatus),
      createStatusBadge("Facility", employer.regulatoryVerificationStatus),
      createStatusBadge("Approval", employer.employerApprovalStatus)
    );

    button.append(heading, identity, statuses);

    button.addEventListener("click", function () {
      if (state.actionPending) return;

      selectEmployer(employerId);
    });

    return button;
  }

  function highlightSelectedEmployer() {
    if (!elements.queueItems) return;

    elements.queueItems.querySelectorAll("[data-employer-id]").forEach(function (button) {
      var selected = button.dataset.employerId === state.selectedEmployerId;

      button.classList.toggle("border-primary", selected);
      button.classList.toggle("bg-light-primary", selected);
    });
  }

  function renderQueue(employers) {
    if (!elements.queueItems) return;

    elements.queueItems.replaceChildren();

    var hasEmployers = Array.isArray(employers) && employers.length > 0;

    elements.queueEmpty?.classList.toggle("d-none", hasEmployers);

    if (!hasEmployers) return;

    var fragment = document.createDocumentFragment();

    employers.forEach(function (employer) {
      fragment.appendChild(createEmployerItem(employer));
    });

    elements.queueItems.appendChild(fragment);
  }

  function updatePagination(pagination) {
    pagination = pagination || {};

    state.total = Number(pagination.total || 0);
    state.totalPages = Math.max(1, Number(pagination.totalPages || 1));

    setText(
      elements.queueCount,
      state.total + " employer" + (state.total === 1 ? "" : "s") + " found"
    );

    setText(elements.pageLabel, "Page " + state.page + " of " + state.totalPages);

    if (elements.previousPage) {
      elements.previousPage.disabled = state.page <= 1;
    }

    if (elements.nextPage) {
      elements.nextPage.disabled = state.page >= state.totalPages;
    }
  }

  // ───────────────────────── LOAD QUEUE ─────────────────────────

  function loadQueue() {
    var requestId = ++state.queueRequestId;

    setQueueLoading(true);

    var params = new URLSearchParams({
      status: state.filter,
      page: String(state.page),
      limit: String(PAGE_SIZE),
    });

    return apiGet(queueUrl + "?" + params.toString())
      .then(function (response) {
        if (requestId !== state.queueRequestId) return;

        var data = response.data.data || {};

        renderQueue(data.employers || []);
        updatePagination(data.pagination || {});
      })
      .catch(function (error) {
        if (requestId !== state.queueRequestId) return;

        renderQueue([]);

        setText(elements.queueCount, "Unable to load employers");

        showFeedback(getErrorMessage(error, "Unable to load verification queue."), "danger");
      })
      .finally(function () {
        if (requestId === state.queueRequestId) {
          setQueueLoading(false);
        }
      });
  }

  // ───────────────────────── VERIFICATION HISTORY ─────────────────────────

  function renderVerificationHistory(history) {
    if (!elements.historyBody) return;

    elements.historyBody.replaceChildren();

    if (!Array.isArray(history) || history.length === 0) {
      var emptyRow = createElement("tr");

      var emptyCell = createElement(
        "td",
        "text-muted text-center py-5",
        "No verification history available."
      );

      emptyCell.colSpan = 4;
      emptyRow.appendChild(emptyCell);

      elements.historyBody.appendChild(emptyRow);

      return;
    }

    history.forEach(function (record) {
      var row = createElement("tr");

      var typeCell = createElement("td", "fw-semibold", record.type === "cac" ? "CAC" : "Facility");

      var providerName = formatStatus(record.provider || "Not recorded");

      var environmentName = record.providerEnvironment
        ? " (" + formatStatus(record.providerEnvironment) + ")"
        : "";

      var providerCell = createElement("td", "text-gray-600", providerName + environmentName);

      var statusCell = createElement("td");

      statusCell.appendChild(createStatusBadge("", record.status));

      var checkedCell = createElement(
        "td",
        "text-gray-600 fs-7",
        formatDate(record.lastCheckedAt || record.createdAt)
      );

      row.append(typeCell, providerCell, statusCell, checkedCell);

      elements.historyBody.appendChild(row);
    });
  }

  // ───────────────────────── EMPLOYER DETAILS ─────────────────────────

  function renderEmployerDetails(data) {
    var employer = data.employer || {};

    setText(elements.businessName, employer.businessName, "Unnamed Business");

    setText(
      elements.businessType,
      formatStatus(employer.type) + " · " + (employer.countryCode || "NG")
    );

    setBadge(elements.accountStatus, employer.accountStatus);

    setText(elements.cacNumber, employer.cacRegistrationNumber);

    setText(elements.regulatoryNumber, employer.regulatoryRegistrationNumber);

    setText(elements.businessEmail, employer.businessEmail);

    setText(
      elements.businessLocation,
      [employer.address, employer.state, employer.lga].filter(Boolean).join(", ")
    );

    // CAC summary
    setBadge(elements.cacStatus, employer.cacVerificationStatus);

    setText(elements.cacName, employer.cacNameOnRecord, "Not yet recorded");

    setText(elements.cacCheckedAt, formatDate(employer.cacLastCheckedAt));

    setText(
      elements.cacNote,
      employer.cacVerificationNote || employer.cacRejectionReason,
      "No verification note recorded."
    );

    // PCN summary
    var isPCN = employer.regulatoryBody === "pcn";

    elements.pcnSection?.classList.toggle("d-none", !isPCN);

    setBadge(elements.pcnStatus, employer.regulatoryVerificationStatus);

    setText(elements.pcnName, employer.regulatoryNameOnRecord, "Not yet recorded");

    if (elements.pcnForm) {
      elements.pcnForm.reset();
    }

    if (elements.pcnRegisteredName) {
      elements.pcnRegisteredName.value = employer.regulatoryNameOnRecord || "";
    }

    // Employer approval
    setBadge(elements.employerApprovalStatus, employer.employerApprovalStatus);

    setText(
      elements.employerApprovalNote,
      employer.employerApprovalNote || employer.employerRejectionReason,
      "Final administrative approval has not yet been recorded."
    );

    // Verification history
    renderVerificationHistory(data.verificationHistory || []);
  }

  // ───────────────────────── EMPLOYER SELECTION ─────────────────────────

  function clearSelection() {
    state.selectedEmployerId = null;
    state.detailsRequestId += 1;

    if (elements.selectedEmployerId) {
      elements.selectedEmployerId.value = "";
    }

    elements.noSelection?.classList.remove("d-none");
    elements.detailsLoading?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");

    highlightSelectedEmployer();
  }

  function selectEmployer(employerId) {
    if (!employerId || state.actionPending) return;

    state.selectedEmployerId = employerId;

    var requestId = ++state.detailsRequestId;

    if (elements.selectedEmployerId) {
      elements.selectedEmployerId.value = employerId;
    }

    clearFeedback();

    highlightSelectedEmployer();
    setDetailsLoading(true);

    apiGet(getEmployerUrl(employerId))
      .then(function (response) {
        if (requestId !== state.detailsRequestId || employerId !== state.selectedEmployerId) {
          return;
        }

        renderEmployerDetails(response.data.data || {});

        elements.detailsContent?.classList.remove("d-none");
      })
      .catch(function (error) {
        if (requestId !== state.detailsRequestId) return;

        showFeedback(getErrorMessage(error, "Unable to load employer details."), "danger");

        elements.noSelection?.classList.remove("d-none");
      })
      .finally(function () {
        if (requestId === state.detailsRequestId) {
          setDetailsLoading(false);
        }
      });
  }

  function refreshSelectedEmployer() {
    var employerId = state.selectedEmployerId;

    if (!employerId) return Promise.resolve();

    var requestId = ++state.detailsRequestId;

    return apiGet(getEmployerUrl(employerId))
      .then(function (response) {
        if (requestId !== state.detailsRequestId || employerId !== state.selectedEmployerId) {
          return;
        }

        renderEmployerDetails(response.data.data || {});
        elements.detailsContent?.classList.remove("d-none");
      })
      .catch(function (error) {
        showFeedback(getErrorMessage(error, "Unable to refresh employer details."), "warning");
      });
  }

  // ───────────────────────── CAC RECHECK ─────────────────────────

  function handleCACRecheck() {
    var employerId = state.selectedEmployerId;

    if (!employerId || state.actionPending) return;

    Swal.fire({
      text:
        "Run a CAC verification check for this employer? " +
        "This request may count toward CAC VAS API usage.",
      icon: "question",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: "Run CAC Check",
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: "btn btn-primary",
        cancelButton: "btn btn-light",
      },
    }).then(function (confirmation) {
      if (!confirmation.isConfirmed) return;

      clearFeedback();
      setActionPending(true);

      apiPost(getEmployerUrl(employerId, "/cac/recheck"), {})
        .then(function (response) {
          var result = response.data.data || {};
          var message = response.data.message || "CAC verification check completed.";

          var alertType = "success";

          if (result.providerFailure) {
            alertType = "warning";
          } else if (result.stagingOnly) {
            alertType = "info";
          } else if (result.requiresReview) {
            alertType = "warning";
          } else if (result.skipped) {
            alertType = "info";
            message = result.reason || "CAC lookup was skipped.";
          }

          showFeedback(message, alertType);

          return Promise.all([refreshSelectedEmployer(), loadQueue()]);
        })
        .catch(function (error) {
          Swal.fire({
            text: getErrorMessage(error, "Unable to complete CAC verification."),
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: {
              confirmButton: "btn btn-primary",
            },
          });
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────────── MANUAL PCN REVIEW ─────────────────────────

  function handlePCNReview(e) {
    e.preventDefault();

    var employerId = state.selectedEmployerId;

    if (!employerId || state.actionPending) return;

    var decision = String(elements.pcnDecision?.value || "").trim();

    var nameOnRecord = String(elements.pcnRegisteredName?.value || "").trim();

    var note = String(elements.pcnReviewNote?.value || "").trim();

    var allowedDecisions = ["verified", "rejected", "needs_review"];

    if (!allowedDecisions.includes(decision)) {
      Swal.fire({
        text: "Please select a valid PCN review decision.",
        icon: "warning",
        buttonsStyling: false,
        confirmButtonText: "Ok, got it!",
        customClass: {
          confirmButton: "btn btn-primary",
        },
      });

      return;
    }

    if (decision === "verified" && !nameOnRecord) {
      Swal.fire({
        text: "Enter the registered premises name before verifying PCN registration.",
        icon: "warning",
        buttonsStyling: false,
        confirmButtonText: "Ok, got it!",
        customClass: {
          confirmButton: "btn btn-primary",
        },
      });

      return;
    }

    if (note.length < 10) {
      Swal.fire({
        text: "Enter a PCN review note of at least 10 characters.",
        icon: "warning",
        buttonsStyling: false,
        confirmButtonText: "Ok, got it!",
        customClass: {
          confirmButton: "btn btn-primary",
        },
      });

      return;
    }

    Swal.fire({
      text:
        "Record this PCN review as " +
        formatStatus(decision) +
        "? This will update the employer's regulatory verification status.",
      icon: "question",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: "Save Review",
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: "btn btn-primary",
        cancelButton: "btn btn-light",
      },
    }).then(function (confirmation) {
      if (!confirmation.isConfirmed) return;

      clearFeedback();
      setActionPending(true);

      apiPost(getEmployerUrl(employerId, "/pcn/review"), {
        decision: decision,
        nameOnRecord: nameOnRecord,
        note: note,
      })
        .then(function (response) {
          return Promise.all([refreshSelectedEmployer(), loadQueue()]).then(function () {
            Swal.fire({
              text: response.data.message || "PCN review saved successfully.",
              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",
              customClass: {
                confirmButton: "btn btn-primary",
              },
            });
          });
        })
        .catch(function (error) {
          Swal.fire({
            text: getErrorMessage(error, "Unable to save PCN verification review."),
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: {
              confirmButton: "btn btn-primary",
            },
          });
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────────── EVENT HANDLERS ─────────────────────────

  function handleRefreshQueue() {
    clearFeedback();
    loadQueue();
  }

  function handleStatusFilterChange() {
    if (state.actionPending) {
      elements.statusFilter.value = state.filter;
      return;
    }

    state.filter = elements.statusFilter.value;
    state.page = 1;

    clearSelection();
    clearFeedback();
    loadQueue();
  }

  function handlePreviousPage() {
    if (state.actionPending || state.page <= 1) return;

    state.page -= 1;

    clearSelection();
    loadQueue();
  }

  function handleNextPage() {
    if (state.actionPending || state.page >= state.totalPages) {
      return;
    }

    state.page += 1;

    clearSelection();
    loadQueue();
  }

  function attachEventHandlers() {
    elements.refreshQueue?.addEventListener("click", handleRefreshQueue);

    elements.statusFilter?.addEventListener("change", handleStatusFilterChange);

    elements.previousPage?.addEventListener("click", handlePreviousPage);

    elements.nextPage?.addEventListener("click", handleNextPage);

    elements.cacRecheck?.addEventListener("click", handleCACRecheck);

    elements.pcnForm?.addEventListener("submit", handlePCNReview);
  }

  // ───────────────────────── INITIALIZATION ─────────────────────────

  return {
    init: function () {
      if (!root) return;

      initializeElements();

      queueUrl = root.dataset.queueUrl || "/admin/employer-verifications/data";

      employerBaseUrl = (root.dataset.employerBaseUrl || "/admin/employers").replace(/\/$/, "");

      csrfToken =
        root.dataset.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || "";

      state.filter = elements.statusFilter?.value || "review";

      attachEventHandlers();

      clearSelection();
      loadQueue();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminEmployerVerifications.init();
});
