// services/shiftCasePageService.js

const mongoose = require("mongoose");

const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");

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

/* ─────────────────────────────── ERRORS / NORMALIZATION ─────────────────────────────── */

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

/* ─────────────────────────────── DISPLAY HELPERS ─────────────────────────────── */

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

function getEvidenceCount(issue) {
  return [
    issue.evidence,
    issue.employerEvidence,
    issue.professionalResponseEvidence,
    issue.adminEvidence,
  ].reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
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

function buildSystemEvidenceView(caseItem) {
  return {
    submissionSnapshot: caseItem.lifecycleSnapshot || null,

    currentAuthority: buildAuthoritativeOccurrenceView(caseItem),
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
  });

  return items.sort(
    (left, right) => new Date(left.at.value).getTime() - new Date(right.at.value).getTime()
  );
}

function buildClaimPositionsView(issue) {
  return {
    professional: {
      statement: issue.statement || null,

      position: issue.details || null,

      evidence: buildEvidenceView(issue.evidence),
    },

    employer: {
      decision: issue.employerDecision || null,

      reason: issue.employerDecisionReason || null,

      position: issue.employerCounterPosition || null,

      evidence: buildEvidenceView(issue.employerEvidence),
    },

    admin: {
      decision: issue.adminDecision || null,

      reason: issue.adminDecisionReason || null,

      outcome: issue.adminOutcome || null,

      evidence: buildEvidenceView(issue.adminEvidence),
    },
  };
}

function buildDisputePositionsView(issue) {
  return {
    employer: {
      statement: issue.statement || null,

      position: issue.details || null,

      evidence: buildEvidenceView(issue.evidence),
    },

    professional: {
      statement: issue.professionalResponseStatement || null,

      position: issue.professionalCounterPosition || null,

      evidence: buildEvidenceView(issue.professionalResponseEvidence),
    },

    admin: {
      decision: issue.adminDecision || null,

      reason: issue.adminDecisionReason || null,

      outcome: issue.adminOutcome || null,

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

    currentBaseSettlementStatus: authority.base.settlementStatus,

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

/* ─────────────────────────────── URL HELPERS ─────────────────────────────── */

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

/* ─────────────────────────────── FILTER / PAGINATION VIEWS ─────────────────────────────── */

function buildTypeOptions({ audience, type, status }) {
  const options =
    audience === AUDIENCES.ADMIN
      ? [
          {
            value: CASE_TYPES.CLAIMS,

            label: "Professional claims",
          },

          {
            value: CASE_TYPES.DISPUTES,

            label: "Employer disputes",
          },
        ]
      : [
          {
            value: CASE_TYPES.ALL,

            label: "All cases",
          },

          {
            value: CASE_TYPES.CLAIMS,

            label: audience === AUDIENCES.PROFESSIONAL ? "My claims" : "Professional claims",
          },

          {
            value: CASE_TYPES.DISPUTES,

            label: "Employer disputes",
          },
        ];

  return options.map((option) => {
    const active = option.value === type;

    return {
      ...option,

      active,

      className: active ? "btn-primary" : "btn-light-primary",

      url: buildCasePageUrl({
        audience,

        type: option.value,

        status,

        page: 1,
      }),
    };
  });
}

function buildStatusOptions({ audience, type, status }) {
  return VALID_STATUSES.map((value) => {
    const active = value === status;

    return {
      value,

      label: value === CASE_TYPES.ALL ? "All statuses" : formatStatus(value),

      active,

      className: active ? "badge-primary" : "badge-light",

      url: buildCasePageUrl({
        audience,

        type,

        status: value,

        page: 1,
      }),
    };
  });
}

function buildPaginationView({ audience, type, status, page, totalItems, totalPages }) {
  const hasPreviousPage = page > 1;

  const hasNextPage = page < totalPages && page < MAX_PAGE;

  const previousPage = Math.max(1, page - 1);

  const nextPage = Math.min(totalPages, page + 1);

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

/* ─────────────────────────────── CASE HELPERS ─────────────────────────────── */

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

      resolved: totals.resolved + item.resolved,

      withdrawn: totals.withdrawn + item.withdrawn,
    }),
    {
      total: 0,

      active: 0,

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

/* ─────────────────────────────── FETCH LAYER ─────────────────────────────── */

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

async function countCases(kind, filter) {
  const Model = getModel(kind);

  const [total, active, resolved, withdrawn] = await Promise.all([
    Model.countDocuments(filter),

    Model.countDocuments({
      ...filter,

      status: "active",
    }),

    Model.countDocuments({
      ...filter,

      status: "resolved",
    }),

    Model.countDocuments({
      ...filter,

      status: "withdrawn",
    }),
  ]);

  return {
    total,

    active,

    resolved,

    withdrawn,
  };
}

/* ─────────────────────────────── PAGE LOADER ─────────────────────────────── */

async function loadCasesPage({
  audience,
  scopeFilter,
  type: requestedType,
  status: requestedStatus,
  page: requestedPage,
  allowedKinds,
  canManage = false,
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

    Promise.all(kinds.map((kind) => countCases(kind, scopeFilter))),
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

      canManage,
    })
  );

  const actionRequired = cases.filter((caseItem) => caseItem.actions.required === true).length;

  return {
    audience,

    pageTitle: getPageTitle(audience, type),

    pageIntro: getPageIntro(audience),

    cases,

    counts: {
      ...counts,

      actionRequired,
    },

    filters: {
      type,

      status,

      typeOptions: buildTypeOptions({
        audience,

        type,

        status,
      }),

      statusOptions: buildStatusOptions({
        audience,

        type,

        status,
      }),
    },

    pagination: buildPaginationView({
      audience,

      type,

      status,

      page: currentPage,

      totalItems,

      totalPages,
    }),
  };
}

/* ─────────────────────────────── AUDIENCE VIEW ROUTING ─────────────────────────────── */

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

/* ─────────────────────────────── COMMON CASE VIEW ─────────────────────────────── */

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
    },
  };
}

/* ─────────────────────────────── COMMON ISSUE VIEW ─────────────────────────────── */

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
  const components =
    caseItem.kind === CASE_KINDS.CLAIM
      ? issue.challengedSettlementComponents
      : issue.affectedSettlementComponents;

  return {
    id: getEntityId(issue),

    type: {
      value: issue.type,

      label: formatStatus(issue.type),
    },

    status: getStatusView(issue.status),

    statement: issue.statement || null,

    details: issue.details || null,

    affectedSettlementComponents: Array.isArray(components)
      ? components.map((component) => ({
          value: component,

          label: formatStatus(component),
        }))
      : [],

    evidenceCount: getEvidenceCount(issue),

    deadline: buildDateView(getIssueDeadline(caseItem, issue)),

    employerDecision: issue.employerDecision
      ? {
          value: issue.employerDecision,

          label: formatStatus(issue.employerDecision),
        }
      : null,

    employerDecisionReason: issue.employerDecisionReason || null,

    professionalResponseStatement: issue.professionalResponseStatement || null,

    adminDecision: issue.adminDecision
      ? {
          value: issue.adminDecision,

          label: formatStatus(issue.adminDecision),
        }
      : null,

    adminDecisionReason: issue.adminDecisionReason || null,
  };
}

/* ─────────────────────────────── ACTION VIEW HELPERS ─────────────────────────────── */

function responseWindowIsOpen(deadline, currentTime = new Date()) {
  if (!deadline) return false;
  const deadlineTime = new Date(deadline).getTime();
  return Number.isFinite(deadlineTime) && currentTime.getTime() < deadlineTime;
}

function unavailableAction() {
  return {
    available: false,

    url: null,
  };
}

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

/* ─────────────────────────────── PROFESSIONAL VIEW ─────────────────────────────── */

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
          }
        : unavailableAction(),
    },
  };
}

/* ─────────────────────────────── EMPLOYER VIEW ─────────────────────────────── */

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

    employerCounterPosition: issue.employerCounterPosition || null,

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
          }
        : unavailableAction(),
    },
  };
}

/* ─────────────────────────────── ADMIN VIEW ─────────────────────────────── */

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

    systemEvidence: buildSystemEvidenceView(caseItem),

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
        ? buildClaimPositionsView(issue)
        : buildDisputePositionsView(issue),

    systemEvidence: buildSystemEvidenceView(caseItem),

    timeline: buildIssueTimeline(issue, caseItem),

    adminOutcome: issue.adminOutcome || null,

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

    /**
     * Approval establishes that current Loqum authority requires correction.
     * adminOutcome records the final evidence-supported fact/value.
     */
    adminOutcomeRequiredForDecisions = ["approved"];
  }

  return {
    available: true,

    decisions,

    adminOutcomeRequiredForDecisions,

    adminOutcome: buildAdminOutcomeFields(issue, caseItem),
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

/* ─────────────────────────────── PROFESSIONAL WITHDRAWAL RULE ─────────────────────────────── */

function canProfessionalWithdrawClaim(caseItem) {
  if (
    caseItem.kind !== CASE_KINDS.CLAIM ||
    caseItem.status !== "active" ||
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

/* ─────────────────────────────── EMPLOYER WITHDRAWAL RULE ─────────────────────────────── */

function canEmployerWithdrawDispute(caseItem, canManage) {
  if (
    !canManage ||
    caseItem.kind !== CASE_KINDS.DISPUTE ||
    caseItem.status !== "active" ||
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

/* ─────────────────────────────── PUBLIC SERVICE ─────────────────────────────── */

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
    });
  }

  static async getEmployerCasesPageData({ businessId, employerContext, type, status, page }) {
    if (!businessId || !mongoose.isValidObjectId(businessId)) {
      throw createPageError("Employer profile context is unavailable.");
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    const canManageCases = canManageAllBranches || isBranchManager;

    if (!canManageCases) {
      throw createPageError("You do not have permission to view these cases.", 403);
    }

    const scopeFilter = {
      business: businessId,
    };

    if (!canManageAllBranches) {
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

    return loadCasesPage({
      audience: AUDIENCES.EMPLOYER,

      scopeFilter,

      type,

      status,

      page,

      allowedKinds: [CASE_KINDS.CLAIM, CASE_KINDS.DISPUTE],

      canManage: true,
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

      canManage: true,
    });
  }
}

module.exports = ShiftCasePageService;
