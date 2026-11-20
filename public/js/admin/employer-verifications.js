// public/js/admin/employer-verifications.js

"use strict";

var AdminEmployerVerifications = (function () {
  var root = null;
  var elements = {};
  var csrfToken = "";
  var queueUrl = "/admin/employer-verifications/data";
  var permitQueueUrl = "/admin/employer-verifications/permits";
  var employerBaseUrl = "/admin/employers";
  var PAGE_SIZE = 20;

  var state = {
    employerPage: 1,
    employerTotalPages: 1,
    employerFilter: "review",
    employerRequestId: 0,
    employerDetailsRequestId: 0,
    selectedEmployerId: null,

    permitPage: 1,
    permitTotalPages: 1,
    permitFilter: "review",
    permitRequestId: 0,
    permitDetailsRequestId: 0,
    permitQueueLoaded: false,
    selectedPermit: null,
    selectedPermitSummary: null,

    actionPending: false,
  };

  // ───────────────────── ELEMENTS ─────────────────────

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

      permitTab: getElement("facilityPermitVerificationTab"),
      refreshPermits: getElement("refreshFacilityPermitQueue"),
      permitStatusFilter: getElement("facilityPermitStatusFilter"),
      permitQueueCount: getElement("facilityPermitQueueCount"),
      permitQueueLoading: getElement("facilityPermitQueueLoading"),
      permitQueueEmpty: getElement("facilityPermitQueueEmpty"),
      permitQueueItems: getElement("facilityPermitQueueItems"),
      permitPreviousPage: getElement("facilityPermitPreviousPage"),
      permitNextPage: getElement("facilityPermitNextPage"),
      permitPageLabel: getElement("facilityPermitPageLabel"),
      permitNoSelection: getElement("facilityPermitNoSelection"),
      permitDetailsLoading: getElement("facilityPermitDetailsLoading"),
      permitDetailsContent: getElement("facilityPermitDetailsContent"),
      permitId: getElement("selectedFacilityPermitId"),
      permitBusinessId: getElement("selectedFacilityPermitBusinessId"),
      permitBranchId: getElement("selectedFacilityPermitBranchId"),
      permitBusinessName: getElement("facilityPermitBusinessName"),
      permitBranchName: getElement("facilityPermitBranchName"),
      permitStatus: getElement("facilityPermitStatus"),
      permitRequirement: getElement("facilityPermitRequirement"),
      permitAuthority: getElement("facilityPermitAuthority"),
      permitNumber: getElement("facilityPermitNumber"),
      permitScope: getElement("facilityPermitScope"),
      permitPremises: getElement("facilityPermitPremises"),
      permitDescription: getElement("facilityPermitDescription"),
      permitSubmittedAt: getElement("facilityPermitSubmittedAt"),
      permitReviewedAt: getElement("facilityPermitReviewedAt"),
      permitDocumentLink: getElement("facilityPermitDocumentLink"),
      recordedValidityType: getElement("facilityPermitRecordedValidityType"),
      recordedValidFrom: getElement("facilityPermitRecordedValidFrom"),
      recordedExpiry: getElement("facilityPermitRecordedExpiry"),
      permitCurrentStatus: getElement("facilityPermitCurrentStatus"),
      permitReviewHistory: getElement("facilityPermitReviewHistory"),
      reviewSection: getElement("facilityPermitReviewSection"),
      reviewForm: getElement("facilityPermitReviewForm"),
      reviewDecision: getElement("facilityPermitDecision"),
      reviewNote: getElement("facilityPermitReviewNote"),
      reviewSubmit: getElement("facilityPermitReviewSubmit"),
      validityFields: getElement("facilityPermitValidityFields"),
      validityType: getElement("facilityPermitValidityType"),
      validFromDate: getElement("facilityPermitValidFromDate"),
      expiryGroup: getElement("facilityPermitExpiryDateGroup"),
      expiryDate: getElement("facilityPermitExpiryDate"),
      licensingYearGroup: getElement("facilityPermitLicensingYearGroup"),
      licensingYear: getElement("facilityPermitLicensingYear"),
      revocationSection: getElement("facilityPermitRevocationSection"),
      revocationForm: getElement("facilityPermitRevocationForm"),
      revocationReason: getElement("facilityPermitRevocationReason"),
      revokeSubmit: getElement("facilityPermitRevokeSubmit"),
    };
  }

  // ───────────────────── DISPLAY HELPERS ─────────────────────

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function setText(element, value, fallback) {
    if (element) element.textContent = clean(value) || fallback || "-";
  }

  function formatStatus(value) {
    return clean(value || "pending")
      .replace(/[_:-]/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function badgeClass(status) {
    var classes = {
      verified: "badge-light-success",
      active: "badge-light-success",
      pending: "badge-light-warning",
      needs_review: "badge-light-warning",
      restricted: "badge-light-warning",
      expired: "badge-light-warning",
      rejected: "badge-light-danger",
      revoked: "badge-light-danger",
      suspended: "badge-light-danger",
      failed: "badge-light-danger",
      banned: "badge-light-danger",
    };
    return classes[status] || "badge-light-secondary";
  }

  function setBadge(element, status) {
    if (!element) return;
    var value = clean(status || "pending").toLowerCase();
    element.className = "badge " + badgeClass(value);
    element.textContent = formatStatus(value);
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function createBadge(status) {
    var badge = createElement("span");
    setBadge(badge, status);
    return badge;
  }

  function formatDate(value) {
    if (!value) return "-";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "-";
    return date.toLocaleString("en-NG", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatPermitDate(value) {
    if (!value) return "-";
    var text = clean(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    var date = new Date(value);
    if (isNaN(date.getTime())) return "-";
    return date.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" });
  }

  function showFeedback(message, type) {
    if (!elements.feedback) return;
    var accepted = ["success", "danger", "warning", "info"];
    var style = accepted.includes(type) ? type : "info";
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
      customClass: { confirmButton: "btn btn-primary" },
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
        headers: { Accept: "application/json" },
      })
      .then(function (response) {
        if (response.data?.success !== true) throw new Error("Unable to load verification data.");
        return response.data.data || {};
      });
  }

  function apiPost(url, data) {
    if (!csrfToken) {
      return Promise.reject(new Error("Security token unavailable. Refresh the page."));
    }
    return axios
      .post(url, data, {
        withCredentials: true,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "CSRF-Token": csrfToken,
        },
      })
      .then(function (response) {
        if (response.data?.success !== true) throw new Error("Unable to complete the request.");
        return response.data;
      });
  }

  function employerUrl(id, suffix) {
    return employerBaseUrl + "/" + encodeURIComponent(id) + "/verification" + (suffix || "");
  }

  function permitUrl(permit, suffix) {
    var businessId = clean(permit.businessId);
    var branchId = clean(permit.branchId);
    var permitId = clean(permit.permitId);
    if (
      ![businessId, branchId, permitId].every(function (id) {
        return /^[a-f0-9]{24}$/i.test(id);
      })
    ) {
      return "";
    }
    return (
      employerBaseUrl +
      "/" +
      encodeURIComponent(businessId) +
      "/branches/" +
      encodeURIComponent(branchId) +
      "/permits/" +
      encodeURIComponent(permitId) +
      (suffix || "")
    );
  }

  function referenceId(value) {
    if (value && typeof value === "object") return clean(value._id || value.id);
    return clean(value);
  }

  // ───────────────────── SHARED ACTION STATE ─────────────────────

  function setActionPending(pending) {
    state.actionPending = pending;

    [
      elements.cacRecheck,
      elements.refreshQueue,
      elements.statusFilter,
      elements.previousPage,
      elements.nextPage,
      elements.refreshPermits,
      elements.permitStatusFilter,
      elements.permitPreviousPage,
      elements.permitNextPage,
    ].forEach(function (element) {
      if (element) element.disabled = pending;
    });

    [elements.reviewSubmit, elements.revokeSubmit].forEach(function (button) {
      if (!button) return;
      if (pending) button.setAttribute("data-kt-indicator", "on");
      else button.removeAttribute("data-kt-indicator");
    });

    updatePermitFormControls();
    updateEmployerPagination();
    updatePermitPagination();
  }

  // ───────────────────── EMPLOYER QUEUE ─────────────────────

  function setEmployerLoading(loading) {
    elements.queueLoading?.classList.toggle("d-none", !loading);
    if (elements.refreshQueue) elements.refreshQueue.disabled = loading || state.actionPending;
  }

  function updateEmployerPagination(pagination) {
    if (pagination) {
      state.employerTotalPages = Math.max(1, Number(pagination.totalPages) || 1);
      setText(elements.queueCount, (Number(pagination.total) || 0) + " employers found");
    }
    setText(elements.pageLabel, "Page " + state.employerPage + " of " + state.employerTotalPages);
    if (elements.previousPage) {
      elements.previousPage.disabled = state.actionPending || state.employerPage <= 1;
    }
    if (elements.nextPage) {
      elements.nextPage.disabled =
        state.actionPending || state.employerPage >= state.employerTotalPages;
    }
  }

  function clearEmployerSelection() {
    state.selectedEmployerId = null;
    state.employerDetailsRequestId += 1;
    if (elements.selectedEmployerId) elements.selectedEmployerId.value = "";
    elements.noSelection?.classList.remove("d-none");
    elements.detailsLoading?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");
    highlightSelectedEmployer();
  }

  function highlightSelectedEmployer() {
    elements.queueItems?.querySelectorAll("[data-employer-id]").forEach(function (item) {
      var active = item.dataset.employerId === state.selectedEmployerId;
      item.classList.toggle("border-primary", active);
      item.classList.toggle("bg-light-primary", active);
    });
  }

  function renderEmployerQueue(employers) {
    if (!elements.queueItems) return;
    elements.queueItems.replaceChildren();
    elements.queueEmpty?.classList.toggle("d-none", employers.length !== 0);

    employers.forEach(function (employer) {
      var id = referenceId(employer._id);
      var item = createElement("button", "btn btn-light text-start w-100 border p-4 mb-3");
      item.type = "button";
      item.dataset.employerId = id;

      var top = createElement(
        "div",
        "d-flex justify-content-between align-items-center gap-2 mb-2"
      );
      top.append(
        createElement("span", "fw-bold text-gray-900", employer.businessName || "Unnamed Business"),
        createBadge(employer.accountStatus || "active")
      );
      item.append(top);
      item.append(
        createElement(
          "div",
          "text-gray-600 fs-7 mb-2",
          formatStatus(employer.type || "business") +
            " · " +
            (employer.cacRegistrationNumber || "-")
        )
      );

      var meta = createElement("div", "d-flex flex-wrap align-items-center gap-2");
      meta.append(
        createElement("span", "text-muted fs-7", "CAC:"),
        createBadge(employer.cacVerificationStatus)
      );
      meta.append(
        createElement("span", "text-muted fs-7", "Branches: " + (employer.branchCount || 0))
      );
      item.append(meta);

      item.addEventListener("click", function () {
        if (!state.actionPending && id) selectEmployer(id);
      });
      elements.queueItems.appendChild(item);
    });
    highlightSelectedEmployer();
  }

  function loadEmployers() {
    var requestId = ++state.employerRequestId;
    var params = new URLSearchParams({
      status: state.employerFilter,
      page: String(state.employerPage),
      limit: String(PAGE_SIZE),
    });
    setEmployerLoading(true);

    return apiGet(queueUrl + "?" + params.toString())
      .then(function (data) {
        if (requestId !== state.employerRequestId) return;
        renderEmployerQueue(Array.isArray(data.employers) ? data.employers : []);
        updateEmployerPagination(data.pagination || {});
      })
      .catch(function (error) {
        if (requestId !== state.employerRequestId) return;
        renderEmployerQueue([]);
        setText(elements.queueCount, "Unable to load employers");
        showFeedback(errorMessage(error, "Unable to load employer queue."), "danger");
      })
      .finally(function () {
        if (requestId === state.employerRequestId) setEmployerLoading(false);
      });
  }

  function renderCACHistory(records) {
    if (!elements.historyBody) return;
    elements.historyBody.replaceChildren();
    if (!Array.isArray(records) || !records.length) {
      var row = createElement("tr");
      var cell = createElement(
        "td",
        "text-center text-muted py-6",
        "No CAC verification history available."
      );
      cell.colSpan = 4;
      row.appendChild(cell);
      elements.historyBody.appendChild(row);
      return;
    }

    records.forEach(function (record) {
      var row = createElement("tr");
      row.append(createElement("td", "fw-semibold", "CAC"));
      row.append(
        createElement(
          "td",
          "text-gray-600",
          formatStatus(record.provider || "Not recorded") +
            (record.providerEnvironment
              ? " (" + formatStatus(record.providerEnvironment) + ")"
              : "")
        )
      );
      var statusCell = createElement("td");
      statusCell.appendChild(createBadge(record.status));
      row.appendChild(statusCell);
      row.append(
        createElement(
          "td",
          "text-gray-600 fs-7",
          formatDate(record.lastCheckedAt || record.createdAt)
        )
      );
      elements.historyBody.appendChild(row);
    });
  }

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
    setBadge(elements.cacStatus, employer.cacVerificationStatus);
    setText(elements.cacName, employer.cacNameOnRecord, "Not yet recorded");
    setText(elements.cacCheckedAt, formatDate(employer.cacLastCheckedAt));
    setText(
      elements.cacNote,
      employer.cacVerificationNote || employer.cacRejectionReason,
      "No verification note recorded."
    );
    renderCACHistory(data.verificationHistory);
  }

  function selectEmployer(id) {
    var requestId = ++state.employerDetailsRequestId;
    state.selectedEmployerId = id;
    if (elements.selectedEmployerId) elements.selectedEmployerId.value = id;
    clearFeedback();
    highlightSelectedEmployer();
    elements.noSelection?.classList.add("d-none");
    elements.detailsContent?.classList.add("d-none");
    elements.detailsLoading?.classList.remove("d-none");

    return apiGet(employerUrl(id))
      .then(function (data) {
        if (requestId !== state.employerDetailsRequestId || state.selectedEmployerId !== id) return;
        renderEmployerDetails(data);
        elements.detailsContent?.classList.remove("d-none");
      })
      .catch(function (error) {
        if (requestId !== state.employerDetailsRequestId) return;
        elements.noSelection?.classList.remove("d-none");
        showFeedback(errorMessage(error, "Unable to load employer details."), "danger");
      })
      .finally(function () {
        if (requestId === state.employerDetailsRequestId) {
          elements.detailsLoading?.classList.add("d-none");
        }
      });
  }

  function recheckCAC() {
    var id = state.selectedEmployerId;
    if (!id || state.actionPending) return;

    confirmAction(
      "Run a CAC recheck for this employer? This may count toward CAC VAS API usage.",
      "Run CAC Check"
    ).then(function (result) {
      if (!result.isConfirmed || state.actionPending || state.selectedEmployerId !== id) return;
      clearFeedback();
      setActionPending(true);
      apiPost(employerUrl(id, "/cac/recheck"), {})
        .then(function (response) {
          var details = response.data || {};
          var style = details.providerFailure || details.requiresReview ? "warning" : "success";
          if (details.skipped || details.stagingOnly) style = "info";
          showFeedback(response.message || "CAC verification check completed.", style);
          return Promise.all([loadEmployers(), selectEmployer(id)]);
        })
        .catch(function (error) {
          notify(errorMessage(error, "Unable to recheck CAC registration."), "error");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────── PERMIT QUEUE ─────────────────────

  function setPermitLoading(loading) {
    elements.permitQueueLoading?.classList.toggle("d-none", !loading);
    if (elements.refreshPermits) elements.refreshPermits.disabled = loading || state.actionPending;
  }

  function updatePermitPagination(pagination) {
    if (pagination) {
      state.permitTotalPages = Math.max(1, Number(pagination.totalPages) || 1);
      setText(elements.permitQueueCount, (Number(pagination.total) || 0) + " permits found");
    }
    setText(elements.permitPageLabel, "Page " + state.permitPage + " of " + state.permitTotalPages);
    if (elements.permitPreviousPage) {
      elements.permitPreviousPage.disabled = state.actionPending || state.permitPage <= 1;
    }
    if (elements.permitNextPage) {
      elements.permitNextPage.disabled =
        state.actionPending || state.permitPage >= state.permitTotalPages;
    }
  }

  function summarizePermit(permit) {
    return {
      businessId: referenceId(permit.business),
      branchId: referenceId(permit.branch),
      permitId: referenceId(permit._id),
      businessName: permit.business?.businessName || "Unnamed Business",
      branchName: permit.branch?.name || "Unnamed Branch",
      branchLocation: [permit.branch?.address, permit.branch?.lga, permit.branch?.state]
        .filter(Boolean)
        .join(", "),
      requirementKey: permit.requirementKey,
      authorityName: permit.authorityName,
      permitNumber: permit.permitNumber,
      status: permit.status,
      revokedAt: permit.revokedAt,
    };
  }

  function highlightSelectedPermit() {
    var selectedId = state.selectedPermitSummary?.permitId || "";
    elements.permitQueueItems?.querySelectorAll("[data-permit-id]").forEach(function (item) {
      var active = item.dataset.permitId === selectedId;
      item.classList.toggle("border-primary", active);
      item.classList.toggle("bg-light-primary", active);
    });
  }

  function clearPermitSelection() {
    state.selectedPermit = null;
    state.selectedPermitSummary = null;
    state.permitDetailsRequestId += 1;
    if (elements.permitId) elements.permitId.value = "";
    if (elements.permitBusinessId) elements.permitBusinessId.value = "";
    if (elements.permitBranchId) elements.permitBranchId.value = "";
    elements.permitNoSelection?.classList.remove("d-none");
    elements.permitDetailsLoading?.classList.add("d-none");
    elements.permitDetailsContent?.classList.add("d-none");
    highlightSelectedPermit();
  }

  function renderPermitQueue(permits) {
    if (!elements.permitQueueItems) return;
    elements.permitQueueItems.replaceChildren();
    elements.permitQueueEmpty?.classList.toggle("d-none", permits.length !== 0);

    permits.forEach(function (permit) {
      var summary = summarizePermit(permit);
      var item = createElement("button", "btn btn-light text-start w-100 border p-4 mb-3");
      item.type = "button";
      item.dataset.permitId = summary.permitId;

      var heading = createElement("div", "d-flex justify-content-between gap-2 mb-2");
      heading.append(
        createElement("span", "fw-bold text-gray-900", summary.businessName),
        createBadge(summary.revokedAt ? "revoked" : summary.status)
      );
      item.append(heading);
      item.append(
        createElement(
          "div",
          "text-gray-700 fs-7",
          summary.branchName + " · " + formatStatus(summary.requirementKey)
        )
      );
      item.append(
        createElement("div", "text-muted fs-7", summary.permitNumber || "No permit number")
      );

      item.addEventListener("click", function () {
        if (!state.actionPending && permitUrl(summary)) selectPermit(summary);
      });
      elements.permitQueueItems.appendChild(item);
    });
    highlightSelectedPermit();
  }

  function loadPermits() {
    var requestId = ++state.permitRequestId;
    var params = new URLSearchParams({
      status: state.permitFilter,
      page: String(state.permitPage),
      limit: String(PAGE_SIZE),
    });
    state.permitQueueLoaded = true;
    setPermitLoading(true);

    return apiGet(permitQueueUrl + "?" + params.toString())
      .then(function (data) {
        if (requestId !== state.permitRequestId) return;
        renderPermitQueue(Array.isArray(data.permits) ? data.permits : []);
        updatePermitPagination(data.pagination || {});
      })
      .catch(function (error) {
        if (requestId !== state.permitRequestId) return;
        renderPermitQueue([]);
        setText(elements.permitQueueCount, "Unable to load permits");
        showFeedback(errorMessage(error, "Unable to load permit queue."), "danger");
      })
      .finally(function () {
        if (requestId === state.permitRequestId) setPermitLoading(false);
      });
  }

  // ───────────────────── PERMIT DETAILS ─────────────────────

  function updatePermitFormControls() {
    var permit = state.selectedPermit;
    var status = clean(permit?.status).toLowerCase();
    var canReview = Boolean(permit) && ["pending", "needs_review"].includes(status);
    var canRevoke = Boolean(permit) && status === "verified" && !permit.revokedAt;
    var approval = canReview && elements.reviewDecision?.value === "verified";
    var type = elements.validityType?.value;

    elements.reviewSection?.classList.toggle("d-none", !canReview);
    elements.revocationSection?.classList.toggle("d-none", !canRevoke);
    elements.validityFields?.classList.toggle("d-none", !approval);
    elements.expiryGroup?.classList.toggle("d-none", !approval || type !== "expiry_date");
    elements.licensingYearGroup?.classList.toggle("d-none", !approval || type !== "licensing_year");

    [elements.reviewDecision, elements.reviewNote].forEach(function (input) {
      if (input) input.disabled = state.actionPending || !canReview;
    });
    [elements.validityType, elements.validFromDate].forEach(function (input) {
      if (input) input.disabled = state.actionPending || !approval;
    });
    if (elements.expiryDate) {
      elements.expiryDate.disabled = state.actionPending || !approval || type !== "expiry_date";
    }
    if (elements.licensingYear) {
      elements.licensingYear.disabled =
        state.actionPending || !approval || type !== "licensing_year";
    }
    if (elements.revocationReason) {
      elements.revocationReason.disabled = state.actionPending || !canRevoke;
    }
    if (elements.reviewSubmit) elements.reviewSubmit.disabled = state.actionPending || !canReview;
    if (elements.revokeSubmit) elements.revokeSubmit.disabled = state.actionPending || !canRevoke;
  }

  function disableDocumentLink() {
    if (!elements.permitDocumentLink) return;
    elements.permitDocumentLink.removeAttribute("href");
    elements.permitDocumentLink.classList.add("disabled");
    elements.permitDocumentLink.setAttribute("aria-disabled", "true");
    elements.permitDocumentLink.setAttribute("tabindex", "-1");
  }

  function renderPermitDetails(data) {
    var permit = data.permit || {};
    var branch = data.branch || {};
    var summary = state.selectedPermitSummary || {};

    state.selectedPermit = permit;
    if (elements.permitId) elements.permitId.value = summary.permitId;
    if (elements.permitBusinessId) elements.permitBusinessId.value = summary.businessId;
    if (elements.permitBranchId) elements.permitBranchId.value = summary.branchId;

    setText(elements.permitBusinessName, summary.businessName);
    setText(elements.permitBranchName, branch.name || summary.branchName);
    setBadge(elements.permitStatus, permit.revokedAt ? "revoked" : permit.status);
    setText(elements.permitRequirement, formatStatus(permit.requirementKey));
    setText(elements.permitAuthority, permit.authorityName);
    setText(elements.permitNumber, permit.permitNumber);
    setText(elements.permitScope, formatStatus(permit.scope));
    setText(
      elements.permitPremises,
      [branch.address, branch.lga, branch.state].filter(Boolean).join(", ") ||
        summary.branchLocation
    );
    setText(elements.permitDescription, permit.permitDescription || "No description provided.");
    setText(elements.permitSubmittedAt, formatDate(permit.submittedAt));
    setText(elements.permitReviewedAt, formatDate(permit.reviewedAt));
    setText(
      elements.recordedValidityType,
      permit.validityType ? formatStatus(permit.validityType) : "Not approved"
    );
    setText(elements.recordedValidFrom, formatPermitDate(permit.validFromDate));
    setText(
      elements.recordedExpiry,
      permit.validityType === "indefinite" ? "No fixed expiry" : formatPermitDate(permit.expiryDate)
    );
    setText(
      elements.permitCurrentStatus,
      permit.revokedAt ? "Revoked" : permit.isCurrent ? "Current" : "Not current"
    );
    setText(
      elements.permitReviewHistory,
      permit.revokedAt
        ? "Revoked: " + formatDate(permit.revokedAt)
        : permit.reviewedAt
          ? "Reviewed: " + formatDate(permit.reviewedAt)
          : "Not yet reviewed."
    );

    var documentUrl = permitUrl(summary, "/document");
    disableDocumentLink();
    if (documentUrl && elements.permitDocumentLink) {
      elements.permitDocumentLink.href = documentUrl;
      elements.permitDocumentLink.classList.remove("disabled");
      elements.permitDocumentLink.removeAttribute("aria-disabled");
      elements.permitDocumentLink.removeAttribute("tabindex");
    }

    elements.reviewForm?.reset();
    elements.revocationForm?.reset();
    updatePermitFormControls();
  }

  function selectPermit(summary) {
    if (state.actionPending) return;
    var url = permitUrl(summary);
    if (!url) return;
    var requestId = ++state.permitDetailsRequestId;
    state.selectedPermitSummary = summary;
    state.selectedPermit = null;
    clearFeedback();
    highlightSelectedPermit();
    elements.permitNoSelection?.classList.add("d-none");
    elements.permitDetailsContent?.classList.add("d-none");
    elements.permitDetailsLoading?.classList.remove("d-none");
    disableDocumentLink();

    return apiGet(url)
      .then(function (data) {
        if (
          requestId !== state.permitDetailsRequestId ||
          summary.permitId !== state.selectedPermitSummary?.permitId
        )
          return;
        renderPermitDetails(data);
        elements.permitDetailsContent?.classList.remove("d-none");
      })
      .catch(function (error) {
        if (requestId !== state.permitDetailsRequestId) return;
        elements.permitNoSelection?.classList.remove("d-none");
        showFeedback(errorMessage(error, "Unable to load facility permit details."), "danger");
      })
      .finally(function () {
        if (requestId === state.permitDetailsRequestId) {
          elements.permitDetailsLoading?.classList.add("d-none");
        }
      });
  }

  // ───────────────────── PERMIT REVIEW ─────────────────────

  function reviewValidity() {
    var type = clean(elements.validityType?.value);
    var validFromDate = clean(elements.validFromDate?.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFromDate)) {
      throw new Error("Select a verified validity start date.");
    }
    if (!["expiry_date", "licensing_year", "indefinite"].includes(type)) {
      throw new Error("Select the approved validity type.");
    }
    var validity = { validityType: type, validFromDate: validFromDate };
    if (type === "expiry_date") {
      validity.expiryDate = clean(elements.expiryDate?.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(validity.expiryDate)) {
        throw new Error("Select the verified permit expiry date.");
      }
    }
    if (type === "licensing_year") {
      var year = clean(elements.licensingYear?.value);
      if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2199) {
        throw new Error("Enter an approved licensing year between 1900 and 2199.");
      }
      validity.licensingYear = Number(year);
    }
    return validity;
  }

  function handlePermitReview(event) {
    event.preventDefault();
    var summary = state.selectedPermitSummary;
    var permit = state.selectedPermit;
    if (!summary || !permit || state.actionPending) return;
    if (!["pending", "needs_review"].includes(permit.status)) return;

    var decision = clean(elements.reviewDecision?.value);
    var note = clean(elements.reviewNote?.value);
    if (!["verified", "needs_review", "rejected"].includes(decision)) {
      notify("Select a valid permit review decision.", "warning");
      return;
    }
    if (!note || note.length > 1000 || (decision === "verified" && note.length < 20)) {
      notify(
        decision === "verified"
          ? "Approval requires a review note of at least 20 characters."
          : "Enter a meaningful review note (up to 1,000 characters).",
        "warning"
      );
      return;
    }

    var payload = { decision: decision, note: note };
    if (decision === "verified") {
      try {
        payload.validity = reviewValidity();
      } catch (error) {
        notify(error.message, "warning");
        return;
      }
    }

    var url = permitUrl(summary, "/review");
    if (!url) return;
    confirmAction(
      "Record this facility permit as " + formatStatus(decision) + "?",
      "Save Review"
    ).then(function (confirmation) {
      if (
        !confirmation.isConfirmed ||
        state.actionPending ||
        state.selectedPermitSummary?.permitId !== summary.permitId
      )
        return;
      setActionPending(true);
      apiPost(url, payload)
        .then(function (response) {
          clearPermitSelection();
          showFeedback(response.message || "Permit review saved.", "success");
          return loadPermits();
        })
        .catch(function (error) {
          notify(errorMessage(error, "Unable to save permit review."), "error");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  function handlePermitRevoke(event) {
    event.preventDefault();
    var summary = state.selectedPermitSummary;
    var permit = state.selectedPermit;
    if (
      !summary ||
      !permit ||
      state.actionPending ||
      permit.status !== "verified" ||
      permit.revokedAt
    ) {
      return;
    }
    var reason = clean(elements.revocationReason?.value);
    if (reason.length < 15 || reason.length > 500) {
      notify("Enter a revocation reason of 15–500 characters.", "warning");
      return;
    }
    var url = permitUrl(summary, "/revoke");
    if (!url) return;
    confirmAction(
      "Revoke this permit? This may affect the branch's regulatory readiness.",
      "Revoke Permit",
      true
    ).then(function (confirmation) {
      if (
        !confirmation.isConfirmed ||
        state.actionPending ||
        state.selectedPermitSummary?.permitId !== summary.permitId
      )
        return;
      setActionPending(true);
      apiPost(url, { reason: reason })
        .then(function (response) {
          clearPermitSelection();
          showFeedback(response.message || "Facility permit revoked.", "success");
          return loadPermits();
        })
        .catch(function (error) {
          notify(errorMessage(error, "Unable to revoke permit."), "error");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────── EVENT HANDLERS ─────────────────────

  function handleEmployerFilter() {
    if (state.actionPending) return;
    state.employerFilter = elements.statusFilter.value;
    state.employerPage = 1;
    clearEmployerSelection();
    clearFeedback();
    loadEmployers();
  }

  function handlePermitFilter() {
    if (state.actionPending) return;
    state.permitFilter = elements.permitStatusFilter.value;
    state.permitPage = 1;
    clearPermitSelection();
    clearFeedback();
    loadPermits();
  }

  function attachEvents() {
    elements.refreshQueue?.addEventListener("click", function () {
      clearFeedback();
      loadEmployers();
    });
    elements.statusFilter?.addEventListener("change", handleEmployerFilter);
    elements.previousPage?.addEventListener("click", function () {
      if (state.actionPending || state.employerPage <= 1) return;
      state.employerPage -= 1;
      clearEmployerSelection();
      loadEmployers();
    });
    elements.nextPage?.addEventListener("click", function () {
      if (state.actionPending || state.employerPage >= state.employerTotalPages) return;
      state.employerPage += 1;
      clearEmployerSelection();
      loadEmployers();
    });
    elements.cacRecheck?.addEventListener("click", recheckCAC);

    elements.permitTab?.addEventListener("shown.bs.tab", function () {
      if (!state.permitQueueLoaded) loadPermits();
    });
    elements.refreshPermits?.addEventListener("click", function () {
      clearFeedback();
      loadPermits();
    });
    elements.permitStatusFilter?.addEventListener("change", handlePermitFilter);
    elements.permitPreviousPage?.addEventListener("click", function () {
      if (state.actionPending || state.permitPage <= 1) return;
      state.permitPage -= 1;
      clearPermitSelection();
      loadPermits();
    });
    elements.permitNextPage?.addEventListener("click", function () {
      if (state.actionPending || state.permitPage >= state.permitTotalPages) return;
      state.permitPage += 1;
      clearPermitSelection();
      loadPermits();
    });
    elements.reviewDecision?.addEventListener("change", updatePermitFormControls);
    elements.validityType?.addEventListener("change", updatePermitFormControls);
    elements.reviewForm?.addEventListener("submit", handlePermitReview);
    elements.revocationForm?.addEventListener("submit", handlePermitRevoke);
  }

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      root = document.querySelector("#adminEmployerVerifications");
      if (!root) return;
      initializeElements();
      csrfToken =
        root.dataset.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || "";
      queueUrl = root.dataset.queueUrl || queueUrl;
      permitQueueUrl = root.dataset.permitQueueUrl || permitQueueUrl;
      employerBaseUrl = (root.dataset.employerBaseUrl || employerBaseUrl).replace(/\/$/, "");
      state.employerFilter = elements.statusFilter?.value || "review";
      state.permitFilter = elements.permitStatusFilter?.value || "review";
      attachEvents();
      clearEmployerSelection();
      clearPermitSelection();
      updateEmployerPagination();
      updatePermitPagination();
      loadEmployers();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminEmployerVerifications.init();
});
