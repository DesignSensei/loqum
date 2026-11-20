// public/js/admin/employer-verifications.js

"use strict";

var AdminEmployerVerifications = (function () {
  var root = document.querySelector("#adminEmployerVerifications");

  var elements = {};
  var csrfToken = "";

  var queueUrl = "/admin/employer-verifications/data";
  var employerBaseUrl = "/admin/employers";

  var permitListUrlTemplate = "";
  var permitDetailUrlTemplate = "";
  var permitReviewUrlTemplate = "";
  var permitRevokeUrlTemplate = "";
  var permitDocumentUrlTemplate = "";

  var PAGE_SIZE = 20;

  var state = {
    page: 1,
    totalPages: 1,
    total: 0,
    filter: "review",
    selectedEmployerId: null,
    selectedPermit: null,
    queueRequestId: 0,
    detailsRequestId: 0,
    permitRequestId: 0,
    actionPending: false,
    branches: [],
    permits: [],
  };

  // ───────────────────────── ELEMENTS ─────────────────────────

  function getElement(id) {
    return document.getElementById(id);
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
      businessEmail: getElement("verificationBusinessEmail"),
      businessLocation: getElement("verificationBusinessLocation"),

      cacStatus: getElement("verificationCACStatus"),
      cacName: getElement("verificationCACName"),
      cacCheckedAt: getElement("verificationCACCheckedAt"),
      cacNote: getElement("verificationCACNote"),
      cacRecheck: getElement("verificationCACRecheck"),

      historyBody: getElement("verificationHistoryBody"),

      permitPanel: null,
      permitList: null,
      permitDetails: null,
      permitForm: null,
      permitDecision: null,
      permitNote: null,
      permitValidityType: null,
      permitExpiryDate: null,
      permitLicensingYear: null,
      permitSubmit: null,
      permitRevoke: null,
    };
  }

  function initializePermitPanel() {
    if (!elements.detailsContent) return;

    // Remove retired employer-wide verification controls.
    [
      "verificationPCNSection",
      "verificationPCNForm",
      "verificationRegulatoryNumber",
      "verificationEmployerApprovalStatus",
      "verificationEmployerApprovalNote",
    ].forEach(function (id) {
      var element = getElement(id);
      if (!element) return;

      var section = element.closest("[data-legacy-verification-section]");

      if (section) {
        section.remove();
      } else if (element.id === "verificationPCNSection") {
        element.remove();
      } else {
        element.classList.add("d-none");
      }
    });

    var panel = createElement("section", "card card-flush mt-8");

    panel.id = "verificationFacilityPermitPanel";

    var header = createElement("div", "card-header align-items-center");

    var title = createElement("h3", "card-title fw-bold", "Branch Facility Permits");

    header.appendChild(title);

    var body = createElement("div", "card-body");

    var description = createElement(
      "p",
      "text-gray-600 mb-5",
      "Facility permits are reviewed for each branch independently. " +
        "Business CAC verification does not establish branch posting readiness."
    );

    var permitList = createElement("div", "d-flex flex-column gap-4 mb-6");

    permitList.id = "verificationFacilityPermitList";

    var permitDetails = createElement("div", "border rounded p-5 d-none");

    permitDetails.id = "verificationFacilityPermitDetails";

    body.append(description, permitList, permitDetails);
    panel.append(header, body);

    elements.detailsContent.appendChild(panel);

    elements.permitPanel = panel;
    elements.permitList = permitList;
    elements.permitDetails = permitDetails;
  }

  // ───────────────────────── HELPERS ─────────────────────────

  function clean(value) {
    return String(value ?? "").trim();
  }

  function setText(element, value, fallback) {
    if (!element) return;

    element.textContent = clean(value) || fallback || "-";
  }

  function formatStatus(value) {
    return clean(value || "pending")
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
      valid: "badge-light-success",

      pending: "badge-light-warning",
      submitted: "badge-light-warning",
      needs_review: "badge-light-warning",
      restricted: "badge-light-warning",
      expired: "badge-light-warning",

      rejected: "badge-light-danger",
      revoked: "badge-light-danger",
      suspended: "badge-light-danger",
      failed: "badge-light-danger",
      banned: "badge-light-danger",

      not_required: "badge-light-secondary",
      missing: "badge-light-secondary",
    };

    return classes[status] || "badge-light-secondary";
  }

  function setBadge(element, status) {
    if (!element) return;

    var normalized = clean(status || "pending").toLowerCase();

    element.className = "badge " + getBadgeClass(normalized);
    element.textContent = formatStatus(normalized);
  }

  function formatDate(value) {
    if (!value) return "-";

    var date = new Date(value);

    if (isNaN(date.getTime())) return "-";

    return date.toLocaleString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDateOnly(value) {
    if (!value) return "-";

    var date = new Date(value);

    if (isNaN(date.getTime())) return "-";

    return date.toLocaleDateString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function toDateInput(value) {
    if (!value) return "";

    var date = new Date(value);

    if (isNaN(date.getTime())) return "";

    return (
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0")
    );
  }

  function createElement(tag, className, value) {
    var element = document.createElement(tag);

    if (className) element.className = className;

    if (value !== undefined && value !== null) {
      element.textContent = String(value);
    }

    return element;
  }

  function appendDetail(parent, label, value) {
    var row = createElement("div", "d-flex justify-content-between gap-4 py-2 border-bottom");

    row.append(
      createElement("span", "text-gray-600", label),
      createElement("span", "fw-semibold text-end text-break", clean(value) || "-")
    );

    parent.appendChild(row);
  }

  function showFeedback(message, type) {
    if (!elements.feedback) return;

    var allowed = ["success", "danger", "warning", "info"];
    var safeType = allowed.includes(type) ? type : "info";

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

  function confirmAction(message, buttonText) {
    return Swal.fire({
      text: message,
      icon: "question",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: buttonText,
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: "btn btn-primary",
        cancelButton: "btn btn-light",
      },
    });
  }

  function createStatusBadge(label, status) {
    var badge = createElement("span", "badge");

    setBadge(badge, status);

    if (label) {
      badge.prepend(document.createTextNode(label + ": "));
    }

    return badge;
  }

  function getRecordId(record) {
    return clean(record?._id || record?.id || record?.permitId);
  }

  function getBranchId(branch) {
    return clean(branch?._id || branch?.id || branch?.branchId);
  }

  function getPermitBranchId(permit) {
    return clean(
      permit?.branchId?._id || permit?.branchId || permit?.branch?._id || permit?.branch?.id
    );
  }

  function getPermitStatus(permit) {
    return clean(permit?.status || permit?.verificationStatus || "pending").toLowerCase();
  }

  function isPermitCurrent(permit) {
    return permit?.isCurrent === true;
  }

  function resolveUrl(template, values) {
    if (!template) return "";

    var url = template.replace(
      /:(employerProfileId|employerId|branchId|permitId)\b|\{(employerProfileId|employerId|branchId|permitId)\}/g,
      function (match, colonKey, braceKey) {
        var key = colonKey || braceKey;
        var value = values[key];

        return encodeURIComponent(clean(value));
      }
    );

    if (
      /:(employerProfileId|employerId|branchId|permitId)\b/.test(url) ||
      /\{(employerProfileId|employerId|branchId|permitId)\}/.test(url)
    ) {
      return "";
    }

    try {
      var parsed = new URL(url, window.location.origin);

      if (parsed.origin !== window.location.origin) {
        return "";
      }

      return parsed.pathname + parsed.search;
    } catch (error) {
      return "";
    }
  }

  function permitUrl(template, permit) {
    var employerId = state.selectedEmployerId;
    var branchId = getPermitBranchId(permit);
    var permitId = getRecordId(permit);

    if (!employerId || !branchId || !permitId) return "";

    return resolveUrl(template, {
      employerProfileId: employerId,
      employerId: employerId,
      branchId: branchId,
      permitId: permitId,
    });
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
      elements.permitDecision,
      elements.permitNote,
      elements.permitValidityType,
      elements.permitExpiryDate,
      elements.permitLicensingYear,
      elements.permitSubmit,
      elements.permitRevoke,
    ].forEach(function (element) {
      if (element) element.disabled = pending;
    });

    [elements.permitSubmit, elements.permitRevoke].forEach(function (button) {
      if (!button) return;

      if (pending) {
        button.setAttribute("data-kt-indicator", "on");
      } else {
        button.removeAttribute("data-kt-indicator");
      }
    });

    if (!pending) updateValidityControls();
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

  function createEmployerItem(employer) {
    var employerId = getRecordId(employer);

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

    heading.append(
      createElement("span", "fw-bold text-gray-900", employer.businessName || "Unnamed Business"),
      createStatusBadge("", employer.accountStatus || "active")
    );

    var identity = createElement(
      "div",
      "text-gray-600 fs-7 mb-3",
      formatStatus(employer.type || "business") + " · " + (employer.cacRegistrationNumber || "-")
    );

    var statuses = createElement("div", "d-flex flex-wrap gap-2");

    statuses.appendChild(createStatusBadge("CAC", employer.cacVerificationStatus));

    // Employer-level regulatory status is intentionally excluded.
    if (Array.isArray(employer.branches)) {
      statuses.appendChild(
        createElement("span", "badge badge-light-secondary", employer.branches.length + " branches")
      );
    } else if (Number.isFinite(Number(employer.branchCount))) {
      statuses.appendChild(
        createElement("span", "badge badge-light-secondary", employer.branchCount + " branches")
      );
    }

    button.append(heading, identity, statuses);

    button.addEventListener("click", function () {
      if (!state.actionPending && employerId) {
        selectEmployer(employerId);
      }
    });

    return button;
  }

  function highlightSelectedEmployer() {
    elements.queueItems?.querySelectorAll("[data-employer-id]").forEach(function (button) {
      var selected = button.dataset.employerId === state.selectedEmployerId;

      button.classList.toggle("border-primary", selected);
      button.classList.toggle("bg-light-primary", selected);
    });
  }

  function renderQueue(employers) {
    if (!elements.queueItems) return;

    elements.queueItems.replaceChildren();

    var valid = Array.isArray(employers) ? employers : [];

    elements.queueEmpty?.classList.toggle("d-none", valid.length > 0);

    var fragment = document.createDocumentFragment();

    valid.forEach(function (employer) {
      fragment.appendChild(createEmployerItem(employer));
    });

    elements.queueItems.appendChild(fragment);
  }

  function updatePagination(pagination) {
    pagination = pagination || {};

    state.total = Number(pagination.total || 0);
    state.totalPages = Math.max(1, Number(pagination.totalPages || 1));

    if (state.totalPages < state.page) {
      state.page = state.totalPages;
    }

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

        var data = response.data?.data || {};

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

    var records = Array.isArray(history) ? history : [];

    if (!records.length) {
      var emptyRow = createElement("tr");
      var emptyCell = createElement(
        "td",
        "text-muted text-center py-5",
        "No CAC verification history available."
      );

      emptyCell.colSpan = 4;
      emptyRow.appendChild(emptyCell);
      elements.historyBody.appendChild(emptyRow);
      return;
    }

    records.forEach(function (record) {
      var row = createElement("tr");

      var typeCell = createElement("td", "fw-semibold", formatStatus(record.type || "cac"));

      var provider = formatStatus(record.provider || "Not recorded");

      if (record.providerEnvironment) {
        provider += " (" + formatStatus(record.providerEnvironment) + ")";
      }

      var providerCell = createElement("td", "text-gray-600", provider);

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

  // ───────────────────────── BRANCH PERMITS ─────────────────────────

  function normalizePermit(permit, branch) {
    var result = Object.assign({}, permit);

    if (!getPermitBranchId(result)) {
      result.branchId = getBranchId(branch);
    }

    if (!result.branchName) {
      result.branchName = branch?.name || branch?.branchName;
    }

    return result;
  }

  function extractBranchPermits(data) {
    var branches = Array.isArray(data.branches) ? data.branches : [];

    var permits = Array.isArray(data.permits) ? data.permits.slice() : [];

    branches.forEach(function (branch) {
      var branchPermits = Array.isArray(branch.permits) ? branch.permits : [];

      branchPermits.forEach(function (permit) {
        permits.push(normalizePermit(permit, branch));
      });
    });

    var seen = new Set();

    return permits.filter(function (permit) {
      var id = getRecordId(permit);
      var branchId = getPermitBranchId(permit);
      var key = branchId + ":" + id;

      if (!id || !branchId || seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  }

  function renderBranchSummary(branch, container) {
    var branchId = getBranchId(branch);
    var readiness = branch.readiness || {};

    var card = createElement("div", "border rounded p-4");

    var top = createElement(
      "div",
      "d-flex justify-content-between align-items-center flex-wrap gap-2"
    );

    var name = createElement(
      "span",
      "fw-bold text-gray-900",
      branch.name || branch.branchName || "Unnamed Branch"
    );

    top.appendChild(name);

    if (typeof readiness.canPost === "boolean") {
      top.appendChild(createStatusBadge("Posting", readiness.canPost ? "verified" : "restricted"));
    }

    card.appendChild(top);

    var location = [branch.address, branch.lga, branch.state].filter(Boolean).join(", ");

    if (location) {
      card.appendChild(createElement("div", "text-gray-600 fs-7 mt-2", location));
    }

    if (branchId) {
      card.dataset.branchId = branchId;
    }

    if (readiness.reason && !readiness.canPost) {
      card.appendChild(
        createElement("div", "text-warning fs-7 mt-2", formatStatus(readiness.reason))
      );
    }

    if (Array.isArray(readiness.missingRequirementKeys)) {
      var missing = readiness.missingRequirementKeys;

      if (missing.length) {
        card.appendChild(
          createElement(
            "div",
            "text-danger fs-7 mt-2",
            "Outstanding: " + missing.map(formatStatus).join(", ")
          )
        );
      }
    }

    container.appendChild(card);
  }

  function createPermitItem(permit) {
    var card = createElement("div", "border rounded p-4");

    var top = createElement(
      "div",
      "d-flex justify-content-between align-items-center flex-wrap gap-2"
    );

    var name = createElement(
      "span",
      "fw-semibold",
      permit.permitDescription || formatStatus(permit.requirementKey) || "Facility Permit"
    );

    top.append(name, createStatusBadge("", getPermitStatus(permit)));

    var details = createElement("div", "text-gray-600 fs-7 mt-2");

    details.textContent =
      (permit.branchName || "Branch") + " · " + (permit.permitNumber || "No permit number");

    var action = createElement("button", "btn btn-sm btn-light-primary mt-3", "View Permit");

    action.type = "button";

    action.addEventListener("click", function () {
      if (!state.actionPending) {
        selectPermit(permit);
      }
    });

    card.append(top, details, action);

    return card;
  }

  function renderPermits() {
    if (!elements.permitList) return;

    elements.permitList.replaceChildren();

    var container = elements.permitList;

    if (state.branches.length) {
      container.appendChild(createElement("h5", "fw-bold mb-2", "Registered Branches"));

      state.branches.forEach(function (branch) {
        renderBranchSummary(branch, container);
      });
    }

    container.appendChild(createElement("h5", "fw-bold mt-5 mb-2", "Facility Permit Records"));

    if (!state.permits.length) {
      container.appendChild(
        createElement(
          "p",
          "text-gray-600",
          "No facility permit records are available for this employer."
        )
      );

      return;
    }

    state.permits.forEach(function (permit) {
      container.appendChild(createPermitItem(permit));
    });
  }

  function refreshPermitData(data) {
    state.branches = Array.isArray(data.branches) ? data.branches : [];

    state.permits = extractBranchPermits(data);

    if (!state.selectedPermit) {
      renderPermits();
      return;
    }

    var previousId = getRecordId(state.selectedPermit);
    var previousBranchId = getPermitBranchId(state.selectedPermit);

    state.selectedPermit =
      state.permits.find(function (permit) {
        return getRecordId(permit) === previousId && getPermitBranchId(permit) === previousBranchId;
      }) || null;

    renderPermits();

    if (state.selectedPermit) {
      renderPermitDetails(state.selectedPermit);
    } else {
      elements.permitDetails?.classList.add("d-none");
    }
  }

  function loadSeparatePermits(employerId) {
    if (!permitListUrlTemplate) return Promise.resolve();

    var requestId = ++state.permitRequestId;

    var url = resolveUrl(permitListUrlTemplate, {
      employerProfileId: employerId,
      employerId: employerId,
    });

    if (!url) return Promise.resolve();

    return apiGet(url)
      .then(function (response) {
        if (requestId !== state.permitRequestId || employerId !== state.selectedEmployerId) {
          return;
        }

        var data = response.data?.data || {};

        refreshPermitData({
          branches: data.branches || state.branches,
          permits: data.permits || [],
        });
      })
      .catch(function (error) {
        if (requestId !== state.permitRequestId) return;

        showFeedback(getErrorMessage(error, "Unable to load facility permits."), "warning");
      });
  }

  // ───────────────────────── PERMIT REVIEW FORM ─────────────────────────

  function createField(labelText, control) {
    var group = createElement("div", "mb-4");

    var label = createElement("label", "form-label fw-semibold", labelText);

    group.append(label, control);

    return group;
  }

  function createOption(value, label) {
    var option = createElement("option", "", label);
    option.value = value;

    return option;
  }

  function createSelect(options) {
    var select = createElement("select", "form-select");

    options.forEach(function (entry) {
      select.appendChild(createOption(entry.value, entry.label));
    });

    return select;
  }

  function updateValidityControls() {
    var decision = elements.permitDecision?.value;
    var type = elements.permitValidityType?.value;
    var approved = decision === "approved";

    if (elements.permitValidityType) {
      elements.permitValidityType.disabled = state.actionPending || !approved;
    }

    if (elements.permitExpiryDate) {
      elements.permitExpiryDate.disabled =
        state.actionPending || !approved || type !== "expiry_date";
    }

    if (elements.permitLicensingYear) {
      elements.permitLicensingYear.disabled =
        state.actionPending || !approved || type !== "licensing_year";
    }
  }

  function renderPermitDetails(permit) {
    if (!elements.permitDetails) return;

    var container = elements.permitDetails;

    container.replaceChildren();
    container.classList.remove("d-none");

    container.appendChild(createElement("h4", "fw-bold mb-4", "Facility Permit Review"));

    appendDetail(container, "Branch", permit.branchName || getPermitBranchId(permit));

    appendDetail(container, "Requirement", formatStatus(permit.requirementKey));

    appendDetail(
      container,
      "Regulatory authority",
      permit.authorityName || permit.authorityCode || "Not recorded"
    );

    appendDetail(container, "Permit number", permit.permitNumber);

    appendDetail(
      container,
      "Registered premises",
      permit.premisesName || permit.registeredPremisesName || "Not recorded"
    );

    appendDetail(container, "Status", formatStatus(getPermitStatus(permit)));

    appendDetail(container, "Current record", isPermitCurrent(permit) ? "Yes" : "No");

    appendDetail(container, "Submitted", formatDate(permit.submittedAt || permit.createdAt));

    appendDetail(container, "Valid from", formatDateOnly(permit.validFromDate));

    appendDetail(container, "Expiry date", formatDateOnly(permit.expiryDate));

    appendDetail(container, "Licensing year", permit.licensingYear);

    if (permit.reviewNote || permit.note) {
      appendDetail(container, "Review note", permit.reviewNote || permit.note);
    }

    var documentUrl = permitUrl(permitDocumentUrlTemplate, permit);

    if (documentUrl) {
      var documentLink = createElement(
        "a",
        "btn btn-light-primary btn-sm mt-4",
        "View Permit Document"
      );

      documentLink.href = documentUrl;
      documentLink.target = "_blank";
      documentLink.rel = "noopener noreferrer";

      container.appendChild(documentLink);
    }

    var form = createElement("form", "border-top mt-6 pt-5");

    form.noValidate = true;

    var heading = createElement("h5", "fw-bold mb-4", "Administrative Decision");

    var decision = createSelect([
      { value: "", label: "Select decision" },
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
      { value: "needs_review", label: "Needs Review" },
    ]);

    var validityType = createSelect([
      { value: "", label: "Select validity" },
      { value: "expiry_date", label: "Actual expiry date" },
      { value: "licensing_year", label: "Licensing year" },
      { value: "life", label: "Confirmed life licence" },
    ]);

    var expiryDate = createElement("input", "form-control");

    expiryDate.type = "date";

    var licensingYear = createElement("input", "form-control");

    licensingYear.type = "number";
    licensingYear.min = "1900";
    licensingYear.max = "2200";
    licensingYear.step = "1";
    licensingYear.placeholder = "Four-digit year";

    var note = createElement("textarea", "form-control");

    note.rows = 3;
    note.placeholder = "Record the evidence reviewed and your decision.";

    if (permit.validityType) {
      validityType.value = permit.validityType;
    }

    if (permit.expiryDate) {
      expiryDate.value = toDateInput(permit.expiryDate);
    }

    if (permit.licensingYear) {
      licensingYear.value = permit.licensingYear;
    }

    var submit = createElement("button", "btn btn-primary", "Save Permit Review");

    submit.type = "submit";

    var revoke = createElement("button", "btn btn-light-danger", "Revoke Permit");

    revoke.type = "button";

    var buttons = createElement("div", "d-flex flex-wrap gap-3 mt-5");

    buttons.append(submit, revoke);

    form.append(
      heading,
      createField("Decision", decision),
      createField("Validity type", validityType),
      createField("Expiry date", expiryDate),
      createField("Licensing year", licensingYear),
      createField("Review note", note),
      buttons
    );

    container.appendChild(form);

    elements.permitForm = form;
    elements.permitDecision = decision;
    elements.permitNote = note;
    elements.permitValidityType = validityType;
    elements.permitExpiryDate = expiryDate;
    elements.permitLicensingYear = licensingYear;
    elements.permitSubmit = submit;
    elements.permitRevoke = revoke;

    submit.disabled = !permitUrl(permitReviewUrlTemplate, permit);

    revoke.disabled =
      !permitUrl(permitRevokeUrlTemplate, permit) || getPermitStatus(permit) === "revoked";

    decision.addEventListener("change", updateValidityControls);
    validityType.addEventListener("change", updateValidityControls);

    form.addEventListener("submit", handlePermitReview);
    revoke.addEventListener("click", handlePermitRevoke);

    updateValidityControls();
  }

  function selectPermit(permit) {
    if (state.actionPending) return;

    state.selectedPermit = permit;
    renderPermitDetails(permit);

    if (!permitDetailUrlTemplate) return;

    var url = permitUrl(permitDetailUrlTemplate, permit);

    if (!url) return;

    var requestId = ++state.permitRequestId;
    var employerId = state.selectedEmployerId;
    var permitId = getRecordId(permit);

    apiGet(url)
      .then(function (response) {
        if (
          requestId !== state.permitRequestId ||
          employerId !== state.selectedEmployerId ||
          permitId !== getRecordId(state.selectedPermit)
        ) {
          return;
        }

        var data = response.data?.data || {};
        var detail = data.permit || data.facilityPermit || data;

        if (!detail || !getRecordId(detail)) return;

        state.selectedPermit = normalizePermit(detail, {
          _id: getPermitBranchId(permit),
          name: permit.branchName,
        });

        renderPermitDetails(state.selectedPermit);
      })
      .catch(function (error) {
        showFeedback(getErrorMessage(error, "Unable to load permit details."), "warning");
      });
  }

  function getReviewValidity() {
    var type = elements.permitValidityType?.value;

    if (type === "expiry_date") {
      var expiryDate = elements.permitExpiryDate?.value;

      if (!expiryDate) {
        throw new Error("Select the permit expiry date.");
      }

      return {
        type: "expiry_date",
        expiryDate: expiryDate,
      };
    }

    if (type === "licensing_year") {
      var year = clean(elements.permitLicensingYear?.value);

      if (!/^\d{4}$/.test(year)) {
        throw new Error("Enter a valid four-digit licensing year.");
      }

      return {
        type: "licensing_year",
        licensingYear: Number(year),
      };
    }

    if (type === "life") {
      return {
        type: "life",
      };
    }

    throw new Error("Select a valid permit validity type.");
  }

  function handlePermitReview(event) {
    event.preventDefault();

    if (state.actionPending || !state.selectedPermit) return;

    var permit = state.selectedPermit;
    var employerId = state.selectedEmployerId;
    var decision = clean(elements.permitDecision?.value);
    var note = clean(elements.permitNote?.value);

    var url = permitUrl(permitReviewUrlTemplate, permit);

    if (!url) {
      notify("The facility permit review endpoint is not configured.", "warning");
      return;
    }

    if (!["approved", "rejected", "needs_review"].includes(decision)) {
      notify("Select a valid review decision.", "warning");
      return;
    }

    if (note.length < 10) {
      notify("Enter a review note of at least 10 characters.", "warning");
      return;
    }

    var payload = {
      decision: decision,
      note: note,
    };

    if (decision === "approved") {
      try {
        payload.validity = getReviewValidity();
      } catch (error) {
        notify(error.message, "warning");
        return;
      }
    }

    confirmAction(
      "Record this branch facility permit as " + formatStatus(decision) + "?",
      "Save Review"
    ).then(function (confirmation) {
      if (!confirmation.isConfirmed || state.actionPending) return;

      if (employerId !== state.selectedEmployerId) return;

      clearFeedback();
      setActionPending(true);

      apiPost(url, payload)
        .then(function (response) {
          showFeedback(response.data?.message || "Facility permit review saved.", "success");

          return Promise.all([refreshSelectedEmployer(), loadQueue()]);
        })
        .catch(function (error) {
          notify(getErrorMessage(error, "Unable to save facility permit review."), "error");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  function handlePermitRevoke() {
    if (state.actionPending || !state.selectedPermit) return;

    var permit = state.selectedPermit;
    var employerId = state.selectedEmployerId;

    var url = permitUrl(permitRevokeUrlTemplate, permit);

    if (!url) {
      notify("The facility permit revocation endpoint is not configured.", "warning");
      return;
    }

    Swal.fire({
      title: "Revoke Facility Permit",
      text:
        "Revocation may immediately prevent this branch from " +
        "posting shifts until its requirements are satisfied.",
      input: "textarea",
      inputPlaceholder: "Reason for revocation",
      inputAttributes: {
        "aria-label": "Reason for revocation",
      },
      icon: "warning",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: "Revoke Permit",
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: "btn btn-danger",
        cancelButton: "btn btn-light",
      },
      preConfirm: function (value) {
        var reason = clean(value);

        if (reason.length < 10) {
          Swal.showValidationMessage("Enter a revocation reason of at least 10 characters.");
          return false;
        }

        return reason;
      },
    }).then(function (confirmation) {
      if (!confirmation.isConfirmed || state.actionPending) return;

      if (employerId !== state.selectedEmployerId) return;

      clearFeedback();
      setActionPending(true);

      apiPost(url, {
        reason: confirmation.value,
      })
        .then(function (response) {
          showFeedback(response.data?.message || "Facility permit revoked.", "success");

          return Promise.all([refreshSelectedEmployer(), loadQueue()]);
        })
        .catch(function (error) {
          notify(getErrorMessage(error, "Unable to revoke facility permit."), "error");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────────── EMPLOYER DETAILS ─────────────────────────

  function renderEmployerDetails(data) {
    var employer = data.employer || {};

    setText(elements.businessName, employer.businessName, "Unnamed Business");

    setText(
      elements.businessType,
      formatStatus(employer.type || "business") + " · " + (employer.countryCode || "NG")
    );

    setBadge(elements.accountStatus, employer.accountStatus);

    setText(elements.cacNumber, employer.cacRegistrationNumber);

    setText(elements.businessEmail, employer.businessEmail);

    setText(
      elements.businessLocation,
      [employer.address, employer.state, employer.lga].filter(Boolean).join(", ")
    );

    // CAC identity
    setBadge(elements.cacStatus, employer.cacVerificationStatus);

    setText(elements.cacName, employer.cacNameOnRecord, "Not yet recorded");

    setText(elements.cacCheckedAt, formatDate(employer.cacLastCheckedAt));

    setText(
      elements.cacNote,
      employer.cacVerificationNote || employer.cacRejectionReason,
      "No verification note recorded."
    );

    // Branch-level permits
    refreshPermitData(data);

    // Business CAC audit history
    renderVerificationHistory(data.verificationHistory || []);
  }

  // ───────────────────────── EMPLOYER SELECTION ─────────────────────────

  function clearSelection() {
    state.selectedEmployerId = null;
    state.selectedPermit = null;
    state.branches = [];
    state.permits = [];

    state.detailsRequestId += 1;
    state.permitRequestId += 1;

    if (elements.selectedEmployerId) {
      elements.selectedEmployerId.value = "";
    }

    elements.noSelection?.classList.remove("d-none");
    elements.detailsLoading?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");

    elements.permitList?.replaceChildren();
    elements.permitDetails?.classList.add("d-none");

    highlightSelectedEmployer();
  }

  function selectEmployer(employerId) {
    if (!employerId || state.actionPending) return;

    state.selectedEmployerId = employerId;
    state.selectedPermit = null;

    var requestId = ++state.detailsRequestId;
    state.permitRequestId += 1;

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

        renderEmployerDetails(response.data?.data || {});

        elements.detailsContent?.classList.remove("d-none");

        return loadSeparatePermits(employerId);
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

        renderEmployerDetails(response.data?.data || {});

        elements.detailsContent?.classList.remove("d-none");

        return loadSeparatePermits(employerId);
      })
      .catch(function (error) {
        if (requestId === state.detailsRequestId && employerId === state.selectedEmployerId) {
          showFeedback(getErrorMessage(error, "Unable to refresh employer details."), "warning");
        }
      });
  }

  // ───────────────────────── CAC RECHECK ─────────────────────────

  function handleCACRecheck() {
    var employerId = state.selectedEmployerId;

    if (!employerId || state.actionPending) return;

    confirmAction(
      "Run a CAC verification check for this employer? " +
        "This may count toward CAC VAS API usage.",
      "Run CAC Check"
    ).then(function (confirmation) {
      if (!confirmation.isConfirmed || state.actionPending) return;

      if (employerId !== state.selectedEmployerId) return;

      clearFeedback();
      setActionPending(true);

      apiPost(getEmployerUrl(employerId, "/cac/recheck"), {})
        .then(function (response) {
          var result = response.data?.data || {};
          var message = response.data?.message || "CAC verification check completed.";

          var alertType = "success";

          if (result.providerFailure || result.requiresReview) {
            alertType = "warning";
          } else if (result.stagingOnly) {
            alertType = "info";
          } else if (result.skipped) {
            alertType = "info";
            message = result.reason || "CAC lookup was skipped.";
          }

          showFeedback(message, alertType);

          return Promise.all([refreshSelectedEmployer(), loadQueue()]);
        })
        .catch(function (error) {
          notify(getErrorMessage(error, "Unable to complete CAC verification."), "error");
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

      // Generic permit endpoints are supplied by the page.
      permitListUrlTemplate = root.dataset.permitListUrlTemplate || "";

      permitDetailUrlTemplate = root.dataset.permitDetailUrlTemplate || "";

      permitReviewUrlTemplate = root.dataset.permitReviewUrlTemplate || "";

      permitRevokeUrlTemplate = root.dataset.permitRevokeUrlTemplate || "";

      permitDocumentUrlTemplate = root.dataset.permitDocumentUrlTemplate || "";

      state.filter = elements.statusFilter?.value || "review";

      initializePermitPanel();
      attachEventHandlers();

      clearSelection();
      loadQueue();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminEmployerVerifications.init();
});
