// services/shiftCasePageService.js

const mongoose = require("mongoose");

const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");

const { OCCURRENCE_EVIDENCE_TYPES } = require("../constants/shiftLifecycle");

const { badgeClass, formatStatus } = require("../utils/statusHelper");
const money = require("../utils/money");

const PAGE_SIZE = 20;
const MAX_PAGE = 100;

const VALID_STATUSES = Object.freeze(["all", "active", "resolved", "withdrawn"]);

const CASE_TYPES = Object.freeze({
  ALL: "all",
  CLAIMS: "claims",
  DISPUTES: "disputes",
});

const CASE_KINDS = Object.freeze({
  CLAIM: "claim",
  DISPUTE: "dispute",
});

const AUDIENCES = Object.freeze({
  PROFESSIONAL: "professional",
  EMPLOYER: "employer",
  ADMIN: "admin",
});

const CASE_PAGE_PATHS = Object.freeze({
  [AUDIENCES.PROFESSIONAL]: "/professional/cases",
  [AUDIENCES.EMPLOYER]: "/employer/cases",
  [AUDIENCES.ADMIN]: "/admin/cases",
});

const CASE_KIND_VIEWS = Object.freeze({
  [CASE_KINDS.CLAIM]: Object.freeze({
    value: CASE_KINDS.CLAIM,
    label: "Professional Claim",
    className: "badge-light-primary",
  }),

  [CASE_KINDS.DISPUTE]: Object.freeze({
    value: CASE_KINDS.DISPUTE,
    label: "Employer Dispute",
    className: "badge-light-danger",
  }),
});

const STATUS_LABEL_OVERRIDES = Object.freeze({
  awaiting_employer_review: "Awaiting Employer Review",
  awaiting_professional_response: "Awaiting Professional Response",
  awaiting_admin_review: "Awaiting Admin Review",
});

const SUMMARY_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "active",
    label: "Active",
    icon: "ki-briefcase",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-primary",
    iconClass: "text-primary",
    valueClass: "text-primary",
  }),

  Object.freeze({
    key: "actionRequired",
    label: "Action required",
    icon: "ki-time",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-warning",
    iconClass: "text-warning",
    valueClass: "text-warning",
  }),

  Object.freeze({
    key: "resolved",
    label: "Resolved",
    icon: "ki-check-circle",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-success",
    iconClass: "text-success",
    valueClass: "text-success",
  }),

  Object.freeze({
    key: "withdrawn",
    label: "Withdrawn",
    icon: "ki-cross-circle",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-secondary",
    iconClass: "text-gray-600",
    valueClass: "text-gray-700",
  }),
]);

const CASE_DATE_FORMATTER = new Intl.DateTimeFormat("en-NG", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Lagos",
});

const CASE_SELECT = [
  "referenceCode",
  "shift",
  "occurrence",
  "assignment",
  "business",
  "branch",
  "professional",

  "submittedIssueTypes",
  "issues",

  "status",
  "submittedAt",

  "challengeDeadlineAt",
  "employerResponseDeadlineAt",
  "professionalResponseDeadlineAt",

  "lifecycleSnapshot",

  "resolvedAt",
  "withdrawnAt",
  "withdrawalReason",
  "withdrawnBy",
].join(" ");

const CASE_POPULATES = Object.freeze([
  {
    path: "shift",
    select: "referenceCode roleTitle currency",
  },

  {
    path: "occurrence",
    select: [
      "referenceCode",
      "occurrenceDate",
      "sequenceNumber",
      "slotNumber",
      "startTime",
      "endTime",

      "status",
      "attendanceStatus",

      "checkedInAt",
      "checkedOutAt",
      "attendanceOverride",
      "checkoutFallback",
      "lateCheckout",

      "baseBillableHours",
      "billableHours",
      "hourlyRate",

      "estimatedEmployerCharge",

      "baseProfessionalPay",
      "basePlatformFee",
      "baseSettlement",

      "overtimeProfessionalPay",
      "overtimePlatformFee",
      "overtimeSettlement",

      "topUpRequired",

      "refundStatus",
      "refundableAmount",
      "refundedAmount",

      "activeClaim",
      "activeDispute",
    ].join(" "),
  },

  {
    path: "business",
    select: "businessName",
  },

  {
    path: "branch",
    select: "name address",
  },

  {
    path: "professional",
    select: "user type specialty",
    populate: {
      path: "user",
      select: "firstName lastName displayName email",
    },
  },

  {
    path: "assignment",
    select: "referenceCode slotNumber",
  },
]);

/* ───────────────────── ERRORS / NORMALIZATION ───────────────────── */

function createPageError(message, statusCode = 500) {
  const error = new Error(message);

  error.name = "ShiftCasePageServiceError";
  error.statusCode = statusCode;

  return error;
}

function normalizePage(value) {
  const page = Number.parseInt(String(value || "1"), 10);

  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, MAX_PAGE) : 1;
}

function normalizeStatus(value) {
  const status = String(value || CASE_TYPES.ALL)
    .trim()
    .toLowerCase();

  return VALID_STATUSES.includes(status) ? status : CASE_TYPES.ALL;
}

function normalizeType(value, audience) {
  const type = String(value || "")
    .trim()
    .toLowerCase();

  if (audience === AUDIENCES.ADMIN) {
    return [CASE_TYPES.CLAIMS, CASE_TYPES.DISPUTES].includes(type) ? type : CASE_TYPES.CLAIMS;
  }

  return [CASE_TYPES.ALL, CASE_TYPES.CLAIMS, CASE_TYPES.DISPUTES].includes(type)
    ? type
    : CASE_TYPES.ALL;
}

/* ───────────────────── DISPLAY HELPERS ───────────────────── */

function getCaseId(caseItem) {
  return caseItem?._id ? String(caseItem._id) : null;
}

function getEntityId(entity) {
  if (!entity) {
    return null;
  }

  return entity._id ? String(entity._id) : String(entity);
}

function getProfessionalName(professional) {
  const user = professional?.user;

  if (!user || typeof user !== "object") {
    return "Professional";
  }

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

  return user.displayName || fullName || user.email || "Professional";
}

function getStatusView(status) {
  return {
    value: status,
    label: STATUS_LABEL_OVERRIDES[status] || formatStatus(status),
    className: badgeClass[status] || "badge-light-secondary",
  };
}

function getCaseKindView(kind) {
  return (
    CASE_KIND_VIEWS[kind] || {
      value: kind,
      label: formatStatus(kind),
      className: "badge-light-secondary",
    }
  );
}

function formatCaseDate(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return CASE_DATE_FORMATTER.format(date);
}

function buildDateView(value) {
  if (!value) {
    return null;
  }

  return {
    value,
    label: formatCaseDate(value),
  };
}

function getPageTitle(audience, type) {
  if (audience === AUDIENCES.ADMIN) {
    return type === CASE_TYPES.DISPUTES ? "Employer Disputes" : "Professional Claims";
  }

  return audience === AUDIENCES.PROFESSIONAL ? "My Cases" : "Business Cases";
}

function getPageIntro(audience) {
  if (audience === AUDIENCES.PROFESSIONAL) {
    return "Track claims and employer disputes connected to your shifts.";
  }

  if (audience === AUDIENCES.EMPLOYER) {
    return "Review claims and disputes for the branches you can access.";
  }

  return "Review escalated cases and completed adjudication history.";
}

function formatCaseAmount(amount, currency) {
  const normalizedAmount = Number(amount || 0);

  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 0 || !currency) {
    return null;
  }

  return money.formatMoney(normalizedAmount, currency);
}

function buildEvidenceView(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    type: item?.type || null,
    reference: item?.reference || null,
    description: item?.description || null,
    submittedByRole: item?.submittedByRole || null,
    submittedByUserId: getEntityId(item?.submittedByUser),
    recordedAt: buildDateView(item?.recordedAt),
  }));
}

function getEffectiveOccurrenceCheckIn(occurrence) {
  return occurrence?.attendanceOverride?.approvedStartTime || occurrence?.checkedInAt || null;
}

function getEffectiveOccurrenceCheckOut(occurrence) {
  return (
    occurrence?.attendanceOverride?.approvedEndTime ||
    occurrence?.checkoutFallback?.approvedEndTime ||
    occurrence?.checkedOutAt ||
    null
  );
}

function buildAuthoritativeOccurrenceView(caseItem) {
  const occurrence = caseItem?.occurrence;

  if (!occurrence || typeof occurrence !== "object") {
    return null;
  }

  const currency = caseItem?.shift?.currency || null;

  const baseProfessionalPay = Number(occurrence.baseProfessionalPay || 0);
  const basePlatformFee = Number(occurrence.basePlatformFee || 0);
  const estimatedEmployerCharge = Number(occurrence.estimatedEmployerCharge || 0);
  const refundableAmount = Number(occurrence.refundableAmount || 0);
  const refundedAmount = Number(occurrence.refundedAmount || 0);

  return {
    status: getStatusView(occurrence.status),
    attendanceStatus: getStatusView(occurrence.attendanceStatus),

    scheduled: {
      startTime: buildDateView(occurrence.startTime),
      endTime: buildDateView(occurrence.endTime),
    },

    attendance: {
      rawCheckInAt: buildDateView(occurrence.checkedInAt),
      rawCheckOutAt: buildDateView(occurrence.checkedOutAt),

      authoritativeCheckInAt: buildDateView(getEffectiveOccurrenceCheckIn(occurrence)),

      authoritativeCheckOutAt: buildDateView(getEffectiveOccurrenceCheckOut(occurrence)),

      attendanceOverride: occurrence.attendanceOverride || null,
      checkoutFallback: occurrence.checkoutFallback || null,
      lateCheckout: occurrence.lateCheckout || null,
    },

    base: {
      billableHours: occurrence.baseBillableHours ?? null,

      professionalPay: baseProfessionalPay,

      professionalPayDisplay: formatCaseAmount(baseProfessionalPay, currency),

      platformFee: basePlatformFee,

      platformFeeDisplay: formatCaseAmount(basePlatformFee, currency),

      employerCharge: baseProfessionalPay + basePlatformFee,

      employerChargeDisplay: formatCaseAmount(baseProfessionalPay + basePlatformFee, currency),

      settlementStatus: occurrence.baseSettlement?.status || "not_due",
    },

    scheduledAllocation: {
      employerCharge: estimatedEmployerCharge,

      employerChargeDisplay: formatCaseAmount(estimatedEmployerCharge, currency),
    },

    refund: {
      status: occurrence.refundStatus || null,

      refundableAmount,

      refundableAmountDisplay: formatCaseAmount(refundableAmount, currency),

      refundedAmount,

      refundedAmountDisplay: formatCaseAmount(refundedAmount, currency),
    },

    overtimeContext: {
      professionalPay: Number(occurrence.overtimeProfessionalPay || 0),

      platformFee: Number(occurrence.overtimePlatformFee || 0),

      settlementStatus: occurrence.overtimeSettlement?.status || "not_due",

      topUpRequired: Number(occurrence.topUpRequired || 0),
    },
  };
}

function addTimelineItem(items, { type, label, at, actor = null, detail = null }) {
  if (!at) {
    return;
  }

  const date = new Date(at);

  if (Number.isNaN(date.getTime())) {
    return;
  }

  items.push({
    type,
    label,
    at: buildDateView(date),
    actor,
    detail,
  });
}

function buildIssueTimeline(issue, caseItem) {
  const items = [];

  addTimelineItem(items, {
    type: "case_submitted",

    label:
      caseItem.kind === CASE_KINDS.CLAIM
        ? "Professional claim submitted"
        : "Employer dispute submitted",

    at: caseItem.submittedAt,
  });

  if (caseItem.kind === CASE_KINDS.CLAIM) {
    addTimelineItem(items, {
      type: "employer_decision",
      label: "Employer reviewed issue",
      at: issue.employerDecidedAt,
      actor: "employer",
      detail: issue.employerDecision || null,
    });

    addTimelineItem(items, {
      type: "admin_escalation",
      label: "Issue moved to admin review",
      at: issue.escalatedAt,
      detail: issue.escalationReason || null,
    });
  } else {
    addTimelineItem(items, {
      type: "professional_response",
      label: "Professional responded to dispute",
      at: issue.professionalRespondedAt,
      actor: "professional",
    });

    addTimelineItem(items, {
      type: "professional_response_expired",
      label: "Professional response opportunity expired",
      at: issue.professionalResponseExpiredAt,
    });

    addTimelineItem(items, {
      type: "admin_review_started",
      label: "Issue moved to admin review",
      at: issue.adminReviewStartedAt,
    });
  }

  addTimelineItem(items, {
    type: "admin_decision",
    label: "Admin resolved issue",
    at: issue.adminDecidedAt,
    actor: "admin",
    detail: issue.adminDecision || null,
  });

  addTimelineItem(items, {
    type: "issue_resolved",
    label: "Issue resolved",
    at: issue.resolvedAt,
  });

  return items.sort(
    (left, right) => new Date(left.at.value).getTime() - new Date(right.at.value).getTime()
  );
}

function buildCaseTimeline(caseItem) {
  const items = [];

  addTimelineItem(items, {
    type: "case_submitted",

    label:
      caseItem.kind === CASE_KINDS.CLAIM
        ? "Professional claim submitted"
        : "Employer dispute submitted",

    at: caseItem.submittedAt,
  });

  for (const issue of Array.isArray(caseItem.issues) ? caseItem.issues : []) {
    const issueLabel = formatStatus(issue.type || "issue");

    for (const entry of buildIssueTimeline(issue, caseItem)) {
      if (entry.type === "case_submitted") {
        continue;
      }

      items.push({
        ...entry,

        issueId: getEntityId(issue),

        issueType: issue.type || null,

        label: `${issueLabel}: ${entry.label}`,
      });
    }
  }

  addTimelineItem(items, {
    type: "case_resolved",
    label: "Case resolved",
    at: caseItem.resolvedAt,
  });

  addTimelineItem(items, {
    type: "case_withdrawn",
    label: "Case withdrawn",
    at: caseItem.withdrawnAt,

    actor: caseItem.kind === CASE_KINDS.CLAIM ? "professional" : "employer",

    detail: caseItem.withdrawalReason || null,
  });

  return items.sort(
    (left, right) => new Date(left.at.value).getTime() - new Date(right.at.value).getTime()
  );
}

function buildClaimPositionsView(issue, caseItem) {
  const currency = caseItem?.shift?.currency || null;

  return {
    professional: {
      label: "Professional",
      statement: issue.statement || null,
      decision: null,
      reason: null,
      position: buildOriginalPositionView(issue, caseItem),
      evidence: buildEvidenceView(issue.evidence),
    },

    employer: {
      label: "Employer",
      statement: null,
      decision: buildDecisionView(issue.employerDecision),
      reason: issue.employerDecisionReason || null,

      position: buildCounterPositionView(issue.employerCounterPosition, currency),

      evidence: buildEvidenceView(issue.employerEvidence),
    },

    admin: {
      label: "Admin",
      statement: null,
      decision: buildDecisionView(issue.adminDecision),
      reason: issue.adminDecisionReason || null,
      position: buildAdminOutcomeView(issue.adminOutcome, caseItem),
      evidence: buildEvidenceView(issue.adminEvidence),
    },
  };
}

function buildDisputePositionsView(issue, caseItem) {
  const currency = caseItem?.shift?.currency || null;

  return {
    employer: {
      label: "Employer",
      statement: issue.statement || null,
      decision: null,
      reason: null,
      position: buildOriginalPositionView(issue, caseItem),
      evidence: buildEvidenceView(issue.evidence),
    },

    professional: {
      label: "Professional",
      statement: issue.professionalResponseStatement || null,

      decision: null,
      reason: null,

      position: buildCounterPositionView(issue.professionalCounterPosition, currency),

      evidence: buildEvidenceView(issue.professionalResponseEvidence),
    },

    admin: {
      label: "Admin",
      statement: null,
      decision: buildDecisionView(issue.adminDecision),
      reason: issue.adminDecisionReason || null,
      position: buildAdminOutcomeView(issue.adminOutcome, caseItem),
      evidence: buildEvidenceView(issue.adminEvidence),
    },
  };
}

function buildDecisionPreviewBaseline(caseItem) {
  const authority = buildAuthoritativeOccurrenceView(caseItem);

  if (!authority) {
    return null;
  }

  return {
    currentBaseProfessionalPay: authority.base.professionalPay,

    currentBaseProfessionalPayDisplay: authority.base.professionalPayDisplay,

    currentBasePlatformFee: authority.base.platformFee,

    currentBasePlatformFeeDisplay: authority.base.platformFeeDisplay,

    currentBaseSettlementStatus: getStatusView(authority.base.settlementStatus),

    currentRefundableAmount: authority.refund.refundableAmount,

    currentRefundableAmountDisplay: authority.refund.refundableAmountDisplay,

    resultingBaseProfessionalPay: null,

    professionalPayoutImpact: null,

    employerRefundImpact: null,

    resultingSettlementStatus: null,

    basePlatformFeeUnchanged: true,

    confirmationNote:
      "The BASE platform fee remains unchanged. The final BASE payout, refund and settlement state are recalculated from the authoritative decision.",
  };
}

/* ───────────────────── URL HELPERS ───────────────────── */

function getCasePagePath(audience) {
  const path = CASE_PAGE_PATHS[audience];

  if (!path) {
    throw createPageError("Unsupported case-page audience.");
  }

  return path;
}

function buildCasePageUrl({ audience, type, status, page = 1 }) {
  const params = new URLSearchParams({
    type,
    status,
    page: String(page),
  });

  return `${getCasePagePath(audience)}?${params.toString()}`;
}

function buildProfessionalDisputeResponseUrl(caseId, issueId) {
  return `/professional/disputes/${caseId}/issues/${issueId}/respond`;
}

function buildProfessionalClaimWithdrawalUrl(caseId) {
  return `/professional/claims/${caseId}/withdraw`;
}

function buildEmployerClaimReviewUrl(caseId, issueId) {
  return `/employer/shifts/claims/${caseId}/issues/${issueId}/review`;
}

function buildEmployerDisputeWithdrawalUrl(caseId) {
  return `/employer/shifts/disputes/${caseId}/withdraw`;
}

function buildAdminResolutionUrl(kind, caseId, issueId) {
  const resource = kind === CASE_KINDS.CLAIM ? "shift-claims" : "shift-disputes";

  return `/admin/${resource}/${caseId}/issues/${issueId}/resolve`;
}

function buildEmployerShiftDetailsUrl(shiftId, occurrenceId) {
  if (!shiftId) {
    return null;
  }

  return occurrenceId
    ? `/employer/shifts/${shiftId}?occurrence=${occurrenceId}`
    : `/employer/shifts/${shiftId}`;
}

/* ───────────────────── SUMMARY / FILTERS ───────────────────── */

function buildSummaryCards(counts = {}) {
  return SUMMARY_CARD_DEFINITIONS.map((definition) => ({
    ...definition,

    value: Number(counts?.[definition.key] || 0),
  }));
}

function getCaseTypeLabel(audience, type) {
  if (type === CASE_TYPES.CLAIMS) {
    return audience === AUDIENCES.PROFESSIONAL ? "My claims" : "Professional claims";
  }

  if (type === CASE_TYPES.DISPUTES) {
    return "Employer disputes";
  }

  return "All cases";
}

function buildFilterOptions({ audience, selectedType, selectedStatus, allowedKinds }) {
  const options = [];

  if (audience === AUDIENCES.ADMIN) {
    if (allowedKinds.includes(CASE_KINDS.CLAIM)) {
      options.push({
        key: "claims",
        label: "Professional claims",
        active: selectedType === CASE_TYPES.CLAIMS && selectedStatus === CASE_TYPES.ALL,
        url: buildCasePageUrl({
          audience,
          type: CASE_TYPES.CLAIMS,
          status: CASE_TYPES.ALL,
          page: 1,
        }),
      });

      VALID_STATUSES.filter((status) => status !== CASE_TYPES.ALL).forEach((status) => {
        options.push({
          key: `claims:${status}`,
          label: `${formatStatus(status)} professional claims`,
          active: selectedType === CASE_TYPES.CLAIMS && selectedStatus === status,
          url: buildCasePageUrl({
            audience,
            type: CASE_TYPES.CLAIMS,
            status,
            page: 1,
          }),
        });
      });
    }

    if (allowedKinds.includes(CASE_KINDS.DISPUTE)) {
      options.push({
        key: "disputes",
        label: "Employer disputes",
        active: selectedType === CASE_TYPES.DISPUTES && selectedStatus === CASE_TYPES.ALL,
        url: buildCasePageUrl({
          audience,
          type: CASE_TYPES.DISPUTES,
          status: CASE_TYPES.ALL,
          page: 1,
        }),
      });

      VALID_STATUSES.filter((status) => status !== CASE_TYPES.ALL).forEach((status) => {
        options.push({
          key: `disputes:${status}`,
          label: `${formatStatus(status)} employer disputes`,
          active: selectedType === CASE_TYPES.DISPUTES && selectedStatus === status,
          url: buildCasePageUrl({
            audience,
            type: CASE_TYPES.DISPUTES,
            status,
            page: 1,
          }),
        });
      });
    }

    return options;
  }

  options.push({
    key: "all",
    label: "All cases",
    active: selectedType === CASE_TYPES.ALL && selectedStatus === CASE_TYPES.ALL,
    url: buildCasePageUrl({
      audience,
      type: CASE_TYPES.ALL,
      status: CASE_TYPES.ALL,
      page: 1,
    }),
  });

  VALID_STATUSES.filter((status) => status !== CASE_TYPES.ALL).forEach((status) => {
    options.push({
      key: `status:${status}`,
      label: `${formatStatus(status)} cases`,
      active: selectedType === CASE_TYPES.ALL && selectedStatus === status,
      url: buildCasePageUrl({
        audience,
        type: CASE_TYPES.ALL,
        status,
        page: 1,
      }),
    });
  });

  if (allowedKinds.includes(CASE_KINDS.CLAIM)) {
    options.push({
      key: "type:claims",
      label: audience === AUDIENCES.PROFESSIONAL ? "My claims" : "Professional claims",
      active: selectedType === CASE_TYPES.CLAIMS && selectedStatus === CASE_TYPES.ALL,
      url: buildCasePageUrl({
        audience,
        type: CASE_TYPES.CLAIMS,
        status: CASE_TYPES.ALL,
        page: 1,
      }),
    });
  }

  if (allowedKinds.includes(CASE_KINDS.DISPUTE)) {
    options.push({
      key: "type:disputes",
      label: "Employer disputes",
      active: selectedType === CASE_TYPES.DISPUTES && selectedStatus === CASE_TYPES.ALL,
      url: buildCasePageUrl({
        audience,
        type: CASE_TYPES.DISPUTES,
        status: CASE_TYPES.ALL,
        page: 1,
      }),
    });
  }

  return options;
}

function buildFiltersView({ audience, type, status, allowedKinds }) {
  const typeLabel = getCaseTypeLabel(audience, type);

  let selectedLabel = typeLabel;

  if (status !== CASE_TYPES.ALL && type !== CASE_TYPES.ALL) {
    selectedLabel = `${formatStatus(status)} · ${typeLabel}`;
  } else if (status !== CASE_TYPES.ALL) {
    selectedLabel = `${formatStatus(status)} cases`;
  }

  const hasActiveFilters =
    audience === AUDIENCES.ADMIN
      ? status !== CASE_TYPES.ALL
      : type !== CASE_TYPES.ALL || status !== CASE_TYPES.ALL;

  const clearType = audience === AUDIENCES.ADMIN ? type : CASE_TYPES.ALL;

  return {
    selectedLabel,

    selectedType: type,

    selectedStatus: status,

    options: buildFilterOptions({
      audience,
      selectedType: type,
      selectedStatus: status,
      allowedKinds,
    }),

    hasActiveFilters,

    clearAction: {
      visible: hasActiveFilters,

      label: "Clear filters",

      buttonClass: "btn-light-danger",

      url: buildCasePageUrl({
        audience,
        type: clearType,
        status: CASE_TYPES.ALL,
        page: 1,
      }),
    },
  };
}

function buildPaginationView({ audience, type, status, page, totalItems, totalPages }) {
  const hasPreviousPage = page > 1;

  const hasNextPage = page < totalPages && page < MAX_PAGE;

  const previousPage = Math.max(1, page - 1);

  const nextPage = Math.min(totalPages, page + 1);

  const startItem = totalItems > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;

  const endItem = totalItems > 0 ? Math.min(page * PAGE_SIZE, totalItems) : 0;

  return {
    page,

    pageSize: PAGE_SIZE,

    totalItems,

    totalPages,

    accessiblePages: Math.min(totalPages, MAX_PAGE),

    capped: totalPages > MAX_PAGE,

    hasPreviousPage,

    hasNextPage,

    previousPage,

    nextPage,

    startItem,

    endItem,

    resultsText:
      totalItems > 0
        ? `Showing ${startItem}-${endItem} of ${totalItems}`
        : "No cases match the current filters.",

    previousUrl: hasPreviousPage
      ? buildCasePageUrl({
          audience,
          type,
          status,
          page: previousPage,
        })
      : null,

    nextUrl: hasNextPage
      ? buildCasePageUrl({
          audience,
          type,
          status,
          page: nextPage,
        })
      : null,
  };
}

/* ───────────────────── CASE HELPERS ───────────────────── */

function getKinds(type) {
  if (type === CASE_TYPES.CLAIMS) {
    return [CASE_KINDS.CLAIM];
  }

  if (type === CASE_TYPES.DISPUTES) {
    return [CASE_KINDS.DISPUTE];
  }

  return [CASE_KINDS.CLAIM, CASE_KINDS.DISPUTE];
}

function getModel(kind) {
  if (kind === CASE_KINDS.CLAIM) {
    return ShiftOccurrenceClaim;
  }

  if (kind === CASE_KINDS.DISPUTE) {
    return ShiftOccurrenceDispute;
  }

  throw createPageError("Unsupported case kind.");
}

function hasEmployerCounterPosition(issue) {
  const position = issue?.employerCounterPosition;

  return Boolean(
    position &&
    (position.correctedCheckInAt ||
      position.correctedCheckOutAt ||
      (position.proposedBaseProfessionalPay !== null &&
        position.proposedBaseProfessionalPay !== undefined))
  );
}

function combineCounts(items) {
  return items.reduce(
    (totals, item) => ({
      total: totals.total + item.total,

      active: totals.active + item.active,

      actionRequired: totals.actionRequired + item.actionRequired,

      resolved: totals.resolved + item.resolved,

      withdrawn: totals.withdrawn + item.withdrawn,
    }),
    {
      total: 0,
      active: 0,
      actionRequired: 0,
      resolved: 0,
      withdrawn: 0,
    }
  );
}

function issueHasAvailableAction(issueView) {
  return Object.values(issueView.actions || {}).some((action) => action?.available === true);
}

function caseRequiresActionFromViews(issues) {
  return Array.isArray(issues) ? issues.some(issueHasAvailableAction) : false;
}

/* ───────────────────── FETCH / COUNT LAYER ───────────────────── */

async function findCases({ kind, filter, limit }) {
  let query = getModel(kind).find(filter).select(CASE_SELECT);

  CASE_POPULATES.forEach((options) => {
    query = query.populate(options);
  });

  const documents = await query
    .sort({
      submittedAt: -1,
      _id: -1,
    })
    .limit(limit)
    .lean()
    .exec();

  return documents.map((document) => ({
    ...document,
    kind,
  }));
}

function buildActionRequiredFilter({ audience, kind, scopeFilter, canManage, currentTime }) {
  if (kind === CASE_KINDS.CLAIM) {
    // Employer's one substantive turn is reviewing the professional claim.
    if (audience === AUDIENCES.EMPLOYER && canManage === true) {
      return {
        ...scopeFilter,

        status: "active",

        employerResponseDeadlineAt: {
          $gt: currentTime,
        },

        "issues.status": "awaiting_employer_review",
      };
    }

    // Admin acts only after the issue reaches final review.
    if (audience === AUDIENCES.ADMIN && canManage === true) {
      return {
        ...scopeFilter,

        status: "active",

        "issues.status": "awaiting_admin_review",
      };
    }

    return null;
  }

  if (kind === CASE_KINDS.DISPUTE) {
    // Professional's one substantive turn is responding to the employer dispute.
    if (audience === AUDIENCES.PROFESSIONAL) {
      return {
        ...scopeFilter,

        status: "active",

        professionalResponseDeadlineAt: {
          $gt: currentTime,
        },

        "issues.status": "awaiting_professional_response",
      };
    }

    // Admin acts only after the issue reaches final review.
    if (audience === AUDIENCES.ADMIN && canManage === true) {
      return {
        ...scopeFilter,

        status: "active",

        "issues.status": "awaiting_admin_review",
      };
    }
  }

  return null;
}

async function countCases({ kind, scopeFilter, actionRequiredFilter }) {
  const Model = getModel(kind);

  const [total, active, actionRequired, resolved, withdrawn] = await Promise.all([
    Model.countDocuments(scopeFilter),

    Model.countDocuments({
      ...scopeFilter,
      status: "active",
    }),

    actionRequiredFilter ? Model.countDocuments(actionRequiredFilter) : Promise.resolve(0),

    Model.countDocuments({
      ...scopeFilter,
      status: "resolved",
    }),

    Model.countDocuments({
      ...scopeFilter,
      status: "withdrawn",
    }),
  ]);

  return {
    total,
    active,
    actionRequired,
    resolved,
    withdrawn,
  };
}

/* ───────────────────── PAGE LOADER ───────────────────── */

async function loadCasesPage({
  audience,
  scopeFilter,
  type: requestedType,
  status: requestedStatus,
  page: requestedPage,
  allowedKinds,
  canManageByKind = {},
  permissions = {},
}) {
  const type = normalizeType(requestedType, audience);

  const status = normalizeStatus(requestedStatus);

  const page = normalizePage(requestedPage);

  const kinds = getKinds(type).filter((kind) => allowedKinds.includes(kind));

  if (kinds.length === 0) {
    throw createPageError("You do not have permission to view these cases.", 403);
  }

  const visibleFilter =
    status === CASE_TYPES.ALL
      ? {
          ...scopeFilter,
        }
      : {
          ...scopeFilter,
          status,
        };

  const fetchLimit = page * PAGE_SIZE;

  const currentTime = new Date();

  const [groups, countGroups] = await Promise.all([
    Promise.all(
      kinds.map((kind) =>
        findCases({
          kind,
          filter: visibleFilter,
          limit: fetchLimit,
        })
      )
    ),

    Promise.all(
      kinds.map((kind) =>
        countCases({
          kind,

          scopeFilter,

          actionRequiredFilter: buildActionRequiredFilter({
            audience,

            kind,

            scopeFilter,

            canManage: canManageByKind?.[kind] === true,

            currentTime,
          }),
        })
      )
    ),
  ]);

  const counts = combineCounts(countGroups);

  const totalItems = status === CASE_TYPES.ALL ? counts.total : counts[status];

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  const currentPage = Math.min(page, totalPages);

  const startIndex = (currentPage - 1) * PAGE_SIZE;

  const rawCases = groups
    .flat()
    .sort(
      (left, right) =>
        new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime() ||
        String(right._id).localeCompare(String(left._id)) ||
        String(left.kind).localeCompare(String(right.kind))
    )
    .slice(startIndex, startIndex + PAGE_SIZE);

  const cases = rawCases.map((caseItem) =>
    buildAudienceCaseView(caseItem, {
      audience,

      canManage: canManageByKind?.[caseItem.kind] === true,
    })
  );

  const pagination = buildPaginationView({
    audience,
    type,
    status,
    page: currentPage,
    totalItems,
    totalPages,
  });

  return {
    audience,

    permissions: {
      canViewCases: permissions.canViewCases === true,
      canManageCases: permissions.canManageCases === true,
    },

    pageTitle: getPageTitle(audience, type),

    pageIntro: getPageIntro(audience),

    cases,

    counts,

    summaryCards: buildSummaryCards(counts),

    filters: buildFiltersView({
      audience,
      type,
      status,
      allowedKinds,
    }),

    resultsHeader: {
      title: "Cases",
      subtitle: pagination.resultsText,
    },

    pagination,
  };
}

/* ───────────────────── AUDIENCE VIEW ROUTING ───────────────────── */

function buildAudienceCaseView(caseItem, { audience, canManage }) {
  if (audience === AUDIENCES.PROFESSIONAL) {
    return buildProfessionalCaseView(caseItem);
  }

  if (audience === AUDIENCES.EMPLOYER) {
    return buildEmployerCaseView(caseItem, canManage);
  }

  if (audience === AUDIENCES.ADMIN) {
    return buildAdminCaseView(caseItem, canManage);
  }

  throw createPageError("Unsupported case-page audience.");
}

/* ───────────────────── COMMON CASE VIEW ───────────────────── */

function buildCommonCaseView(caseItem) {
  const caseId = getCaseId(caseItem);

  const shiftId = getEntityId(caseItem.shift);

  const occurrenceId = getEntityId(caseItem.occurrence);

  return {
    id: caseId,

    kind: getCaseKindView(caseItem.kind),

    referenceCode: caseItem.referenceCode,

    status: getStatusView(caseItem.status),

    submittedAt: buildDateView(caseItem.submittedAt),

    challengeDeadline: buildDateView(caseItem.challengeDeadlineAt),

    employerResponseDeadline: buildDateView(caseItem.employerResponseDeadlineAt),

    professionalResponseDeadline: buildDateView(caseItem.professionalResponseDeadlineAt),

    shift: {
      id: shiftId,

      referenceCode: caseItem.shift?.referenceCode || null,

      roleTitle: caseItem.shift?.roleTitle || "Shift",

      currency: caseItem.shift?.currency || null,
    },

    assignment: {
      id: getEntityId(caseItem.assignment),

      referenceCode: caseItem.assignment?.referenceCode || null,

      slotNumber: caseItem.assignment?.slotNumber ?? caseItem.occurrence?.slotNumber ?? null,
    },

    occurrence: {
      id: occurrenceId,

      slotNumber: caseItem.occurrence?.slotNumber ?? null,

      referenceCode: caseItem.occurrence?.referenceCode || "Occurrence",

      occurrenceDate: buildDateView(caseItem.occurrence?.occurrenceDate),

      sequenceNumber: caseItem.occurrence?.sequenceNumber || null,

      startTime: buildDateView(caseItem.occurrence?.startTime),

      endTime: buildDateView(caseItem.occurrence?.endTime),
    },

    business: {
      name: caseItem.business?.businessName || "Business",
    },

    branch: {
      name: caseItem.branch?.name || "Branch",

      address: caseItem.branch?.address || null,
    },

    withdrawal: {
      reason: caseItem.withdrawalReason || null,

      withdrawnAt: buildDateView(caseItem.withdrawnAt),

      withdrawnByUserId: getEntityId(caseItem.withdrawnBy),
    },
  };
}

/* ───────────────────── COMMON ISSUE VIEW ───────────────────── */

function getIssueDeadline(caseItem, issue) {
  if (caseItem.kind === CASE_KINDS.CLAIM && issue.status === "awaiting_employer_review") {
    return caseItem.employerResponseDeadlineAt;
  }

  if (caseItem.kind === CASE_KINDS.DISPUTE && issue.status === "awaiting_professional_response") {
    return caseItem.professionalResponseDeadlineAt;
  }

  return null;
}

function buildIssueView(issue, caseItem) {
  const isClaim = caseItem.kind === CASE_KINDS.CLAIM;

  const components = isClaim
    ? issue.challengedSettlementComponents
    : issue.affectedSettlementComponents;

  const settlementComponents = Array.isArray(components)
    ? components.map((component) => ({
        value: component,

        label: formatStatus(component),
      }))
    : [];

  return {
    id: getEntityId(issue),

    type: {
      value: issue.type,

      label: formatStatus(issue.type),
    },

    status: getStatusView(issue.status),

    statement: issue.statement || null,

    originalPosition: buildOriginalPositionView(issue, caseItem),

    settlementScope: {
      type: isClaim ? "challenged" : "affected",

      label: isClaim ? "Challenged settlement components" : "Affected settlement components",

      components: settlementComponents,
    },

    submissionEvidence: buildEvidenceView(issue.evidence),

    partyResponse: buildPartyResponseView(issue, caseItem),

    deadline: buildDateView(getIssueDeadline(caseItem, issue)),

    adminDecision: issue.adminDecision
      ? {
          value: issue.adminDecision,

          label: formatStatus(issue.adminDecision),
        }
      : null,

    adminDecisionReason: issue.adminDecisionReason || null,
  };
}

/* ───────────────────── ACTION VIEW HELPERS ───────────────────── */

function responseWindowIsOpen(deadline, currentTime = new Date()) {
  if (!deadline) {
    return false;
  }

  const deadlineTime = new Date(deadline).getTime();

  return Number.isFinite(deadlineTime) && currentTime.getTime() < deadlineTime;
}

function unavailableAction() {
  return {
    available: false,
    url: null,
  };
}

function buildEvidenceTypeOptions() {
  return OCCURRENCE_EVIDENCE_TYPES.map((type) => ({
    value: type,

    label: formatStatus(type),
  }));
}

function buildEvidenceActionConfig() {
  return {
    allowed: true,

    optional: true,

    maxItems: 10,

    referenceMaxLength: 1000,

    descriptionMaxLength: 500,

    typeOptions: buildEvidenceTypeOptions(),
  };
}

/* ───────────────────── POSITION VIEWS ───────────────────── */

function buildProfessionalCounterPositionFields(issue) {
  if (issue.type === "attendance_correction") {
    return [
      {
        name: "correctedCheckInAt",

        inputName: "counterPosition[correctedCheckInAt]",

        label: "Your corrected check-in (optional)",

        control: "datetime-local",

        columnClass: "col-md-6",
      },

      {
        name: "correctedCheckOutAt",

        inputName: "counterPosition[correctedCheckOutAt]",

        label: "Your corrected checkout (optional)",

        control: "datetime-local",

        columnClass: "col-md-6",
      },
    ];
  }

  return [
    {
      name: "proposedBaseProfessionalPay",

      inputName: "counterPosition[proposedBaseProfessionalPay]",

      label: "Your proposed BASE pay in minor units (optional)",

      control: "number",

      columnClass: "col-12",

      min: 0,

      step: 1,
    },
  ];
}

function buildEmployerCounterPositionFields(issue) {
  if (issue.type === "attendance_correction") {
    return [
      {
        name: "correctedCheckInAt",

        inputName: "counterPosition[correctedCheckInAt]",

        label: "Corrected check-in (optional)",

        control: "datetime-local",

        columnClass: "col-md-6",
      },

      {
        name: "correctedCheckOutAt",

        inputName: "counterPosition[correctedCheckOutAt]",

        label: "Corrected checkout (optional)",

        control: "datetime-local",

        columnClass: "col-md-6",
      },
    ];
  }

  return [
    {
      name: "proposedBaseProfessionalPay",

      inputName: "counterPosition[proposedBaseProfessionalPay]",

      label: "Proposed BASE professional pay in minor units (optional)",

      control: "number",

      columnClass: "col-12",

      min: 0,

      step: 1,
    },
  ];
}

function buildCounterPositionView(position, currency) {
  if (!position || typeof position !== "object") {
    return null;
  }

  const fields = [];

  if (position.correctedCheckInAt) {
    fields.push({
      name: "correctedCheckInAt",

      label: "Corrected check-in",

      displayValue: formatCaseDate(position.correctedCheckInAt),
    });
  }

  if (position.correctedCheckOutAt) {
    fields.push({
      name: "correctedCheckOutAt",

      label: "Corrected checkout",

      displayValue: formatCaseDate(position.correctedCheckOutAt),
    });
  }

  if (
    position.proposedBaseProfessionalPay !== null &&
    position.proposedBaseProfessionalPay !== undefined
  ) {
    const amount = Number(position.proposedBaseProfessionalPay);

    fields.push({
      name: "proposedBaseProfessionalPay",

      label: "Proposed BASE professional pay",

      value: amount,

      displayValue: formatCaseAmount(amount, currency) || String(amount),
    });
  }

  if (fields.length === 0) {
    return null;
  }

  return {
    fields,
  };
}

function buildDecisionView(value) {
  if (!value) {
    return null;
  }

  return {
    value,

    label: formatStatus(value),
  };
}

function buildOriginalPositionView(issue, caseItem) {
  const details = issue?.details;

  if (!details) {
    return null;
  }

  if (typeof details === "string") {
    const value = details.trim();

    return value
      ? {
          fields: [
            {
              name: "details",

              label: "Details",

              displayValue: value,
            },
          ],
        }
      : null;
  }

  if (typeof details !== "object" || Array.isArray(details)) {
    return null;
  }

  const currency = caseItem?.shift?.currency || null;

  const fields = [];

  const attendanceCorrection =
    details.attendanceCorrection && typeof details.attendanceCorrection === "object"
      ? details.attendanceCorrection
      : null;

  if (attendanceCorrection?.correctedCheckInAt) {
    fields.push({
      name: "correctedCheckInAt",

      label: "Corrected check-in",

      displayValue: formatCaseDate(attendanceCorrection.correctedCheckInAt),
    });
  }

  if (attendanceCorrection?.correctedCheckOutAt) {
    fields.push({
      name: "correctedCheckOutAt",

      label: "Corrected checkout",

      displayValue: formatCaseDate(attendanceCorrection.correctedCheckOutAt),
    });
  }

  if (caseItem.kind === CASE_KINDS.CLAIM) {
    if (
      details.expectedBaseProfessionalPay !== null &&
      details.expectedBaseProfessionalPay !== undefined
    ) {
      const amount = Number(details.expectedBaseProfessionalPay);

      fields.push({
        name: "expectedBaseProfessionalPay",

        label: "Expected BASE professional pay",

        value: amount,

        displayValue: formatCaseAmount(amount, currency) || String(amount),
      });
    }
  }

  if (caseItem.kind === CASE_KINDS.DISPUTE) {
    if (
      details.proposedBaseProfessionalPay !== null &&
      details.proposedBaseProfessionalPay !== undefined
    ) {
      const amount = Number(details.proposedBaseProfessionalPay);

      fields.push({
        name: "proposedBaseProfessionalPay",

        label: "Proposed BASE professional pay",

        value: amount,

        displayValue: formatCaseAmount(amount, currency) || String(amount),
      });
    }
  }

  if (fields.length === 0) {
    return null;
  }

  return {
    fields,
  };
}

function buildAdminOutcomeView(outcome, caseItem) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return null;
  }

  const currency = caseItem?.shift?.currency || null;

  const fields = [];

  if (outcome.finalCheckInAt) {
    fields.push({
      name: "finalCheckInAt",

      label: "Final authoritative check-in",

      displayValue: formatCaseDate(outcome.finalCheckInAt),
    });
  }

  if (outcome.finalCheckOutAt) {
    fields.push({
      name: "finalCheckOutAt",

      label: "Final authoritative checkout",

      displayValue: formatCaseDate(outcome.finalCheckOutAt),
    });
  }

  if (outcome.finalBaseProfessionalPay !== null && outcome.finalBaseProfessionalPay !== undefined) {
    const amount = Number(outcome.finalBaseProfessionalPay);

    fields.push({
      name: "finalBaseProfessionalPay",

      label: "Final BASE professional pay",

      value: amount,

      displayValue: formatCaseAmount(amount, currency) || String(amount),
    });
  }

  if (outcome.adjustedOutcome) {
    fields.push({
      name: "adjustedOutcome",

      label: "Recorded adjusted outcome",

      displayValue: String(outcome.adjustedOutcome),
    });
  }

  if (outcome.finalOutcome) {
    fields.push({
      name: "finalOutcome",

      label: "Recorded final outcome",

      displayValue: String(outcome.finalOutcome),
    });
  }

  if (fields.length === 0) {
    return null;
  }

  return {
    fields,
  };
}

/* ───────────────────── PARTY RESPONSE VIEW ───────────────────── */

function buildPartyResponseView(issue, caseItem) {
  const currency = caseItem?.shift?.currency || null;

  // --- PROFESSIONAL CLAIM ---
  // Professional submits first; employer gets one response/review turn.

  if (caseItem.kind === CASE_KINDS.CLAIM) {
    const counterPosition = buildCounterPositionView(issue.employerCounterPosition, currency);

    const evidence = buildEvidenceView(issue.employerEvidence);

    const decision = issue.employerDecision
      ? {
          value: issue.employerDecision,

          label: formatStatus(issue.employerDecision),
        }
      : null;

    const reason = issue.employerDecisionReason || null;

    const respondedAt = buildDateView(issue.employerDecidedAt);

    const hasResponse =
      Boolean(decision) ||
      Boolean(reason) ||
      Boolean(counterPosition) ||
      evidence.length > 0 ||
      Boolean(respondedAt);

    if (!hasResponse) {
      return null;
    }

    return {
      role: "employer",

      label: "Employer response",

      decision,

      statement: null,

      reason,

      counterPosition,

      evidence,

      respondedAt,
    };
  }

  // --- EMPLOYER DISPUTE ---
  // Employer submits first; professional gets one response turn.

  if (caseItem.kind === CASE_KINDS.DISPUTE) {
    const counterPosition = buildCounterPositionView(issue.professionalCounterPosition, currency);

    const evidence = buildEvidenceView(issue.professionalResponseEvidence);

    const statement = issue.professionalResponseStatement || null;

    const respondedAt = buildDateView(issue.professionalRespondedAt);

    const hasResponse =
      Boolean(statement) || Boolean(counterPosition) || evidence.length > 0 || Boolean(respondedAt);

    if (!hasResponse) {
      return null;
    }

    return {
      role: "professional",

      label: "Professional response",

      decision: null,

      statement,

      reason: null,

      counterPosition,

      evidence,

      respondedAt,
    };
  }

  return null;
}

/* ───────────────────── PROFESSIONAL VIEW ───────────────────── */

function buildProfessionalCaseView(caseItem) {
  const common = buildCommonCaseView(caseItem);

  const issues = Array.isArray(caseItem.issues)
    ? caseItem.issues.map((issue) => buildProfessionalIssueView(issue, caseItem, common.id))
    : [];

  const canWithdraw = canProfessionalWithdrawClaim(caseItem);

  return {
    ...common,

    issues,

    actions: {
      required: caseRequiresActionFromViews(issues),

      withdraw: canWithdraw
        ? {
            available: true,

            url: buildProfessionalClaimWithdrawalUrl(common.id),

            label: "Withdraw claim",

            reasonLabel: "Withdrawal reason",

            reasonPlaceholder: "Explain why this claim is being withdrawn",

            reasonMinLength: 10,

            reasonMaxLength: 500,
          }
        : unavailableAction(),
    },
  };
}

function buildProfessionalIssueView(issue, caseItem, caseId) {
  const view = buildIssueView(issue, caseItem);

  const issueId = view.id;

  const canRespondToDispute =
    caseItem.status === "active" &&
    caseItem.kind === CASE_KINDS.DISPUTE &&
    issue.status === "awaiting_professional_response" &&
    responseWindowIsOpen(caseItem.professionalResponseDeadlineAt);

  return {
    ...view,

    actions: {
      respondToDispute: canRespondToDispute
        ? {
            available: true,

            url: buildProfessionalDisputeResponseUrl(caseId, issueId),

            statementLabel: "Response statement",

            submitLabel: "Submit response",

            counterPositionFields: buildProfessionalCounterPositionFields(issue),

            evidence: buildEvidenceActionConfig(),
          }
        : unavailableAction(),
    },
  };
}

/* ───────────────────── EMPLOYER VIEW ───────────────────── */

function buildEmployerCaseView(caseItem, canManage) {
  const common = buildCommonCaseView(caseItem);

  const issues = Array.isArray(caseItem.issues)
    ? caseItem.issues.map((issue) => buildEmployerIssueView(issue, caseItem, common.id, canManage))
    : [];

  const canWithdraw = canEmployerWithdrawDispute(caseItem, canManage);

  return {
    ...common,

    shift: {
      ...common.shift,

      detailsUrl: buildEmployerShiftDetailsUrl(common.shift.id, common.occurrence.id),
    },

    professional: {
      id: getEntityId(caseItem.professional),

      name: getProfessionalName(caseItem.professional),

      type: caseItem.professional?.type
        ? {
            value: caseItem.professional.type,

            label: formatStatus(caseItem.professional.type),
          }
        : null,

      specialty: caseItem.professional?.specialty || null,
    },

    issues,

    actions: {
      required: caseRequiresActionFromViews(issues),

      withdraw: canWithdraw
        ? {
            available: true,

            url: buildEmployerDisputeWithdrawalUrl(common.id),

            label: "Withdraw dispute",

            reasonLabel: "Withdrawal reason",

            reasonPlaceholder: "Explain why this dispute is being withdrawn",

            reasonMinLength: 10,

            reasonMaxLength: 500,
          }
        : unavailableAction(),
    },
  };
}

function buildEmployerIssueView(issue, caseItem, caseId, canManage) {
  const view = buildIssueView(issue, caseItem);

  const canReview =
    canManage === true &&
    caseItem.status === "active" &&
    caseItem.kind === CASE_KINDS.CLAIM &&
    issue.status === "awaiting_employer_review" &&
    responseWindowIsOpen(caseItem.employerResponseDeadlineAt);

  return {
    ...view,

    actions: {
      review: canReview
        ? {
            available: true,

            url: buildEmployerClaimReviewUrl(caseId, view.id),

            submitLabel: "Submit review",

            decisions: [
              {
                value: "approved",

                label: "Approve professional position",
              },

              {
                value: "rejected",

                label: "Reject professional position",
              },
            ],

            counterPositionDecision: "rejected",

            counterPositionFields: buildEmployerCounterPositionFields(issue),

            evidence: buildEvidenceActionConfig(),
          }
        : unavailableAction(),
    },
  };
}

/* ───────────────────── ADMIN VIEW ───────────────────── */

function buildAdminCaseView(caseItem, canManage) {
  const common = buildCommonCaseView(caseItem);

  const issues = Array.isArray(caseItem.issues)
    ? caseItem.issues.map((issue) => buildAdminIssueView(issue, caseItem, common.id, canManage))
    : [];

  return {
    ...common,

    professional: {
      id: getEntityId(caseItem.professional),

      name: getProfessionalName(caseItem.professional),

      type: caseItem.professional?.type
        ? {
            value: caseItem.professional.type,

            label: formatStatus(caseItem.professional.type),
          }
        : null,

      specialty: caseItem.professional?.specialty || null,
    },

    authoritativeOccurrence: buildAuthoritativeOccurrenceView(caseItem),

    timeline: buildCaseTimeline(caseItem),

    issues,

    actions: {
      required: caseRequiresActionFromViews(issues),

      withdraw: unavailableAction(),
    },
  };
}

function buildAdminIssueView(issue, caseItem, caseId, canManage) {
  const view = buildIssueView(issue, caseItem);

  const canAdjudicate =
    canManage === true && caseItem.status === "active" && issue.status === "awaiting_admin_review";

  return {
    ...view,

    positions:
      caseItem.kind === CASE_KINDS.CLAIM
        ? buildClaimPositionsView(issue, caseItem)
        : buildDisputePositionsView(issue, caseItem),

    timeline: buildIssueTimeline(issue, caseItem),

    decisionPreview: buildDecisionPreviewBaseline(caseItem),

    actions: {
      adjudicate: canAdjudicate
        ? {
            available: true,

            url: buildAdminResolutionUrl(caseItem.kind, caseId, view.id),

            submitLabel: "Resolve issue",
          }
        : unavailableAction(),
    },

    adjudication: buildAdminAdjudicationView(issue, caseItem, canAdjudicate),
  };
}

function buildAdminAdjudicationView(issue, caseItem, canAdjudicate) {
  if (!canAdjudicate) {
    return {
      available: false,

      decisions: [],

      adminOutcome: null,

      adminOutcomeRequiredForDecisions: [],

      evidence: null,
    };
  }

  let decisions = [];

  let adminOutcomeRequiredForDecisions = [];

  if (caseItem.kind === CASE_KINDS.CLAIM) {
    decisions = [
      {
        value: "approve_professional",

        label: "Approve professional position",
      },

      {
        value: "maintain_current",

        label: "Maintain current Loqum record",
      },

      {
        value: "adjusted",

        label: "Set adjusted outcome",
      },
    ];

    if (hasEmployerCounterPosition(issue)) {
      decisions.splice(1, 0, {
        value: "approve_employer",

        label: "Approve employer position",
      });
    }

    adminOutcomeRequiredForDecisions = ["adjusted"];
  }

  if (caseItem.kind === CASE_KINDS.DISPUTE) {
    decisions = [
      {
        value: "approved",

        label: "Approve employer dispute",
      },

      {
        value: "rejected",

        label: "Reject employer dispute",
      },
    ];

    // Approval establishes a corrected authoritative fact/value.
    adminOutcomeRequiredForDecisions = ["approved"];
  }

  return {
    available: true,

    decisions,

    adminOutcomeRequiredForDecisions,

    adminOutcome: buildAdminOutcomeFields(issue, caseItem),

    evidence: buildEvidenceActionConfig(),
  };
}

function buildAdminOutcomeFields(issue, caseItem) {
  if (issue.type === "attendance_correction") {
    return {
      type: "attendance_correction",

      fields: [
        {
          name: "finalCheckInAt",

          inputName: "adminOutcome[finalCheckInAt]",

          label: "Final authoritative check-in",

          control: "datetime-local",

          columnClass: "col-md-6",
        },

        {
          name: "finalCheckOutAt",

          inputName: "adminOutcome[finalCheckOutAt]",

          label: "Final authoritative checkout",

          control: "datetime-local",

          columnClass: "col-md-6",
        },
      ],
    };
  }

  const fields = [
    {
      name: "finalBaseProfessionalPay",

      inputName: "adminOutcome[finalBaseProfessionalPay]",

      label: "Final BASE professional pay (minor units)",

      control: "number",

      columnClass: "col-md-5",

      min: 0,

      step: 1,
    },
  ];

  if (caseItem.kind === CASE_KINDS.CLAIM && issue.type === "employer_fault") {
    fields.push({
      name: "adjustedOutcome",

      inputName: "adminOutcome[adjustedOutcome]",

      label: "Recorded adjusted outcome",

      control: "textarea",

      columnClass: "col-md-7",

      rows: 2,

      maxLength: 1500,
    });
  }

  if (caseItem.kind === CASE_KINDS.DISPUTE && issue.type === "other_financial_fact") {
    fields.push({
      name: "finalOutcome",

      inputName: "adminOutcome[finalOutcome]",

      label: "Recorded final outcome",

      control: "textarea",

      columnClass: "col-md-7",

      rows: 2,

      maxLength: 1500,
    });
  }

  return {
    type: "financial",

    fields,
  };
}

/* ───────────────────── WITHDRAWAL RULES ───────────────────── */

// --- PROFESSIONAL CLAIM WITHDRAWAL ---

function canProfessionalWithdrawClaim(caseItem) {
  if (
    caseItem.kind !== CASE_KINDS.CLAIM ||
    caseItem.status !== "active" ||
    !responseWindowIsOpen(caseItem.employerResponseDeadlineAt) ||
    !Array.isArray(caseItem.issues) ||
    caseItem.issues.length === 0
  ) {
    return false;
  }

  return caseItem.issues.every(
    (issue) =>
      issue.status === "awaiting_employer_review" &&
      !issue.employerDecision &&
      !issue.employerDecidedAt &&
      !issue.employerDecidedBy &&
      !issue.employerDecisionReason &&
      !issue.employerCounterPosition &&
      !(Array.isArray(issue.employerEvidence) && issue.employerEvidence.length > 0) &&
      !issue.escalatedAt &&
      !issue.adminDecision &&
      !issue.resolvedAt
  );
}

// --- EMPLOYER DISPUTE WITHDRAWAL ---

function canEmployerWithdrawDispute(caseItem, canManage) {
  if (
    !canManage ||
    caseItem.kind !== CASE_KINDS.DISPUTE ||
    caseItem.status !== "active" ||
    !responseWindowIsOpen(caseItem.professionalResponseDeadlineAt) ||
    !Array.isArray(caseItem.issues) ||
    caseItem.issues.length === 0
  ) {
    return false;
  }

  return caseItem.issues.every((issue) => {
    const hasProfessionalActivity = Boolean(
      issue.professionalResponseStatement ||
      issue.professionalRespondedAt ||
      issue.professionalRespondedBy ||
      issue.professionalResponseExpiredAt ||
      (Array.isArray(issue.professionalResponseEvidence) &&
        issue.professionalResponseEvidence.length > 0) ||
      issue.professionalCounterPosition
    );

    const hasAdminActivity = Boolean(
      issue.adminReviewStartedAt ||
      issue.adminDecision ||
      issue.adminDecisionReason ||
      issue.adminDecidedAt ||
      issue.adminDecidedBy ||
      issue.adminOutcome ||
      issue.resolvedAt ||
      (Array.isArray(issue.adminEvidence) && issue.adminEvidence.length > 0)
    );

    return (
      issue.status === "awaiting_professional_response" &&
      !hasProfessionalActivity &&
      !hasAdminActivity
    );
  });
}

/* ───────────────────── PUBLIC SERVICE ───────────────────── */

class ShiftCasePageService {
  static async getProfessionalCasesPageData({ professionalId, type, status, page }) {
    if (!professionalId || !mongoose.isValidObjectId(professionalId)) {
      throw createPageError("Professional profile context is unavailable.");
    }

    return loadCasesPage({
      audience: AUDIENCES.PROFESSIONAL,

      scopeFilter: {
        professional: professionalId,
      },

      type,

      status,

      page,

      allowedKinds: [CASE_KINDS.CLAIM, CASE_KINDS.DISPUTE],

      permissions: {
        canViewCases: true,

        canManageCases: true,
      },
    });
  }

  static async getEmployerCasesPageData({ businessId, employerContext, type, status, page }) {
    if (!businessId || !mongoose.isValidObjectId(businessId)) {
      throw createPageError("Employer profile context is unavailable.");
    }

    const canViewClaims = employerContext?.canViewClaims === true;

    const canViewDisputes = employerContext?.canViewDisputes === true;

    const canManageClaims = canViewClaims && employerContext?.canManageClaims === true;

    const canManageDisputes = canViewDisputes && employerContext?.canManageDisputes === true;

    const canViewCases = canViewClaims || canViewDisputes;

    const canManageCases = canManageClaims || canManageDisputes;

    if (!canViewCases) {
      throw createPageError("You do not have permission to view these cases.", 403);
    }

    const hasBusinessWideCaseAccess =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const scopeFilter = {
      business: businessId,
    };

    if (!hasBusinessWideCaseAccess) {
      const assignedBranchIds = (employerContext?.assignedBranchIds || []).filter((branchId) =>
        mongoose.isValidObjectId(branchId)
      );

      if (assignedBranchIds.length === 0) {
        throw createPageError("You are not assigned to a branch that can access cases.", 403);
      }

      scopeFilter.branch = {
        $in: assignedBranchIds,
      };
    }

    const allowedKinds = [];

    if (canViewClaims) {
      allowedKinds.push(CASE_KINDS.CLAIM);
    }

    if (canViewDisputes) {
      allowedKinds.push(CASE_KINDS.DISPUTE);
    }

    return loadCasesPage({
      audience: AUDIENCES.EMPLOYER,

      scopeFilter,

      type,

      status,

      page,

      allowedKinds,

      canManageByKind: {
        [CASE_KINDS.CLAIM]: canManageClaims,

        [CASE_KINDS.DISPUTE]: canManageDisputes,
      },

      permissions: {
        canViewCases,

        canManageCases,
      },
    });
  }

  static async getAdminCasesPageData({ type, status, page }) {
    return loadCasesPage({
      audience: AUDIENCES.ADMIN,

      scopeFilter: {},

      type,

      status,

      page,

      allowedKinds: [CASE_KINDS.CLAIM, CASE_KINDS.DISPUTE],

      canManageByKind: {
        [CASE_KINDS.CLAIM]: true,

        [CASE_KINDS.DISPUTE]: true,
      },

      permissions: {
        canViewCases: true,

        canManageCases: true,
      },
    });
  }
}

module.exports = ShiftCasePageService;
