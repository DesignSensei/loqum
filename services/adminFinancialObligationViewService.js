const mongoose = require("mongoose");
const FinancialObligation = require("../models/FinancialObligation");
const EmployerProfile = require("../models/EmployerProfile");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const User = require("../models/User");
const PaystackService = require("./paystackService");
const RefundService = require("./financialObligationRefundService");

const BASE = "/admin/financial-obligations";
const LIMIT = 25;

const TYPES = {
  retired_dva_funding: "Retired DVA Funding",
  closed_wallet_withdrawal_reversal: "Closed-Wallet Withdrawal Reversal",
  historical_commercial_payment: "Historical Commercial Payment",
};

const STATUSES = {
  outstanding: "Outstanding",
  all: "All Obligations",
  open: "Open",
  awaiting_provider: "Awaiting Provider",
  needs_attention: "Needs Attention",
  review_required: "Review Required",
  settled: "Settled",
};

const OWNERS = {
  employer: "Employer",
  professional: "Professional",
};

const MODES = {
  live: "Live",
  test: "Test",
};

const AWAITING = ["dispatching", "pending", "processing"];

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function clean(value, max = 200) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max) {
    fail("Invalid filter value.");
  }
  return value.trim();
}

function choice(value, allowed, fallback = "") {
  const selected = clean(value) || fallback;
  if (selected && !Object.prototype.hasOwnProperty.call(allowed, selected)) {
    fail("Unsupported filter value.");
  }
  return selected;
}

function id(value) {
  if (!/^[a-f0-9]{24}$/i.test(value || "")) {
    fail("Invalid identifier.");
  }
  return new mongoose.Types.ObjectId(value);
}

function dateFilter(value) {
  const v = clean(value, 10);
  if (!v) return "";
  const d = new Date(v + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      !Number.isFinite(d.getTime()) ||
      d.toISOString().slice(0, 10) !== v) {
    fail("Invalid date filter.");
  }
  return v;
}

function label(value) {
  return value
    ? String(value).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "-";
}

function date(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "-";
}

function money(value, currency) {
  const raw = String(value ?? 0);
  if (!/^\d+(?:\.0+)?$/.test(raw)) {
    return currency + " " + raw + " minor units";
  }

  const n = BigInt(raw.split(".")[0]);

  if (!["NGN", "GHS", "KES", "USD", "ZAR"].includes(currency)) {
    return currency + " " + n.toLocaleString("en-GB") + " minor units";
  }

  return currency + " " +
    (n / 100n).toLocaleString("en-GB") + "." +
    String(n % 100n).padStart(2, "0");
}

function mode() {
  const m = PaystackService.getMode();
  if (!MODES[m]) fail("Paystack environment is unavailable.", 503);
  return m;
}

function options(values, selected, emptyLabel = null) {
  const result = Object.entries(values).map(([value, text]) => ({
    value, label: text, selected: value === selected,
  }));

  if (emptyLabel) {
    result.unshift({
      value: "", label: emptyLabel, selected: !selected,
    });
  }

  return result;
}

function normalize(query) {
  const f = {
    q: clean(query.q),
    status: choice(query.status, STATUSES, "outstanding"),
    type: choice(query.type, TYPES),
    ownerType: choice(query.ownerType, OWNERS),
    mode: choice(query.mode, MODES, mode()),
    currency: clean(query.currency, 3).toUpperCase(),
    from: dateFilter(query.from),
    to: dateFilter(query.to),
    before: clean(query.before, 24),
    after: clean(query.after, 24),
  };

  if (f.currency && !/^[A-Z]{3}$/.test(f.currency)) {
    fail("Invalid currency.");
  }

  if (f.before && f.after) fail("Conflicting pagination cursors.");
  if (f.before) id(f.before);
  if (f.after) id(f.after);

  if (f.from && f.to && f.from > f.to) {
    fail("Invalid date range.");
  }

  return f;
}

function awaitingQuery() {
  return {
    status: { $in: ["open", "review_required"] },
    $or: [
      { "refundExecution.state": { $in: AWAITING } },
      { "payoutExecution.state": { $in: AWAITING } },
    ],
  };
}

function attentionQuery() {
  return {
    status: "review_required",
    $nor: [
      { "refundExecution.state": { $in: AWAITING } },
      { "payoutExecution.state": { $in: AWAITING } },
    ],
  };
}

function buildQuery(f) {
  const clauses = [{ providerMode: f.mode }];

  if (f.status === "outstanding") {
    clauses.push({ status: { $in: ["open", "review_required"] } });
  } else if (f.status === "awaiting_provider") {
    clauses.push(awaitingQuery());
  } else if (f.status === "needs_attention") {
    clauses.push(attentionQuery());
  } else if (f.status !== "all") {
    clauses.push({ status: f.status });
  }

  for (const key of ["type", "ownerType", "currency"]) {
    if (f[key]) clauses.push({ [key]: f[key] });
  }

  if (f.from || f.to) {
    const range = {};

    if (f.from) range.$gte = new Date(f.from + "T00:00:00Z");

    if (f.to) {
      const end = new Date(f.to + "T00:00:00Z");
      end.setUTCDate(end.getUTCDate() + 1);
      range.$lt = end;
    }

    clauses.push({ createdAt: range });
  }

  if (f.q) {
    const identities = [
      "providerReference",
      "providerTransactionId",
      "providerTransferCode",
      "refundExecution.providerRefundId",
      "payoutExecution.reference",
      "payoutExecutionHistory.reference",
      "settlement.reference",
    ].map(key => ({ [key]: f.q }));

    if (/^[a-f0-9]{24}$/i.test(f.q)) {
      for (const key of [
        "_id", "employer", "professional", "wallet",
        "withdrawalTransaction", "commercialTransaction",
      ]) {
        identities.push({ [key]: id(f.q) });
      }
    }

    clauses.push({ $or: identities });
  }

  return { $and: clauses };
}

function pageUrl(filters, cursor = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value && !["before", "after"].includes(key)) {
      params.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(cursor)) {
    params.set(key, value);
  }

  return BASE + "?" + params.toString();
}

/* ---------- Historical owners ---------- */

async function ownersFor(records) {
  const employerIds = records.filter(o => o.employer).map(o => o.employer);
  const professionalIds = records.filter(o => o.professional).map(o => o.professional);

  const [employers, professionals] = await Promise.all([
    EmployerProfile.find({ _id: { $in: employerIds } })
      .select("_id businessName accountStatus").lean(),
    ProfessionalProfile.find({ _id: { $in: professionalIds } })
      .select("_id user type accountStatus").lean(),
  ]);

  const users = await User.find({
    _id: { $in: professionals.map(p => p.user).filter(Boolean) },
  }).select("_id firstName lastName").lean();

  const userMap = new Map(users.map(u => [String(u._id), u]));
  const result = new Map();

  for (const e of employers) {
    result.set(String(e._id), {
      name: e.businessName,
      status: label(e.accountStatus),
    });
  }

  for (const p of professionals) {
    const u = userMap.get(String(p.user));

    result.set(String(p._id), {
      name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || label(p.type),
      status: label(p.accountStatus),
    });
  }

  return result;
}

function row(o, owners) {
  const ownerId = String(o.employer || o.professional || "");
  const owner = owners.get(ownerId);
  const state = o.refundExecution?.state || o.payoutExecution?.state;

  return {
    id: String(o._id),
    ownerId,
    owner: owner?.name || label(o.ownerType),
    ownerStatus: owner?.status || "Unavailable",
    ownerType: label(o.ownerType),
    reference: o.providerReference,
    type: TYPES[o.type] || label(o.type),
    amount: money(o.amount, o.currency),
    status: label(o.status),
    execution: label(state),
    createdAt: date(o.createdAt),
    statusClass: o.status === "settled"
      ? "badge-light-success"
      : "badge-light-warning",
    url: BASE + "/" + String(o._id),
  };
}

/* ---------- Financial summary ---------- */

async function metrics(f) {
  const match = { providerMode: f.mode };
  if (f.currency) match.currency = f.currency;

  const open = { $ne: ["$status", "settled"] };

  const state = {
    $ifNull: [
      "$refundExecution.state",
      { $ifNull: ["$payoutExecution.state", "none"] },
    ],
  };

  const awaiting = {
    $and: [open, { $in: [state, AWAITING] }],
  };

  const attention = {
    $and: [
      { $eq: ["$status", "review_required"] },
      { $not: [{ $in: [state, AWAITING] }] },
    ],
  };

  const settled = { $eq: ["$status", "settled"] };

  const group = { _id: "$currency" };

  for (const [key, condition] of Object.entries({
    open, awaiting, attention, settled,
  })) {
    group[key + "Count"] = {
      $sum: { $cond: [condition, 1, 0] },
    };

    group[key + "Amount"] = {
      $sum: {
        $cond: [condition, { $toDecimal: "$amount" }, { $toDecimal: 0 }],
      },
    };
  }

  const result = await FinancialObligation.aggregate([
    { $match: match },
    { $group: group },
    { $sort: { _id: 1 } },
  ]);

  return result.map(g => ({
    currency: g._id,
    cards: [
      ["open", "Total Outstanding"],
      ["awaiting", "Awaiting Provider"],
      ["attention", "Needs Attention"],
      ["settled", "Total Settled"],
    ].map(([key, title]) => ({
      title,
      count: g[key + "Count"],
      amount: money(g[key + "Amount"], g._id),
    })),
  }));
}

async function getListPage({ adminId, query = {} }) {
  await RefundService.assertAdmin(adminId);

  const filters = normalize(query);
  const base = buildQuery(filters);
  const clauses = [base];

  if (filters.before) {
    clauses.push({ _id: { $lt: id(filters.before) } });
  }

  if (filters.after) {
    clauses.push({ _id: { $gt: id(filters.after) } });
  }

  const direction = filters.after ? 1 : -1;

  const [found, summary, currencies] = await Promise.all([
    FinancialObligation.find({ $and: clauses })
      .select(
        "_id ownerType employer professional type status amount currency " +
        "providerReference createdAt refundExecution.state payoutExecution.state"
      )
      .sort({ _id: direction })
      .limit(LIMIT + 1)
      .lean(),

    metrics(filters),

    FinancialObligation.distinct("currency", {
      providerMode: filters.mode,
    }),
  ]);

  const records = found.slice(0, LIMIT);
  if (direction === 1) records.reverse();

  const owners = await ownersFor(records);

  let previousUrl = null;
  let nextUrl = null;

  if (records.length) {
    const first = records[0]._id;
    const last = records[records.length - 1]._id;

    const [previous, next] = await Promise.all([
      FinancialObligation.exists({
        $and: [base, { _id: { $gt: first } }],
      }),
      FinancialObligation.exists({
        $and: [base, { _id: { $lt: last } }],
      }),
    ]);

    if (previous) {
      previousUrl = pageUrl(filters, { after: String(first) });
    }

    if (next) {
      nextUrl = pageUrl(filters, { before: String(last) });
    }
  }

  const currencyOptions = Object.fromEntries(
    [...new Set([...currencies, filters.currency].filter(Boolean))]
      .sort().map(c => [c, c])
  );

  return {
    filters,
    summary,
    rows: records.map(o => row(o, owners)),
    filterOptions: [
      { name: "status", label: "Status", options: options(STATUSES, filters.status) },
      { name: "type", label: "Type", options: options(TYPES, filters.type, "All Types") },
      { name: "ownerType", label: "Owner", options: options(OWNERS, filters.ownerType, "All Owners") },
      { name: "mode", label: "Environment", options: options(MODES, filters.mode) },
      { name: "currency", label: "Currency", options: options(currencyOptions, filters.currency, "All Currencies") },
    ],
    previousUrl,
    nextUrl,
    firstUrl: pageUrl(filters),
  };
}

/* ---------- Financial actions ---------- */

function actionsFor(o) {
  if (o.providerMode !== mode()) return [];

  const actions = [];

  function add(key, title, confirmation = null, inputs = []) {
    actions.push({
      key, title, confirmation, inputs,
      url: BASE + "/" + String(o._id) + "/" + key,
    });
  }

  if (["retired_dva_funding", "historical_commercial_payment"].includes(o.type)) {
    if (o.status === "settled") return actions;

    if (!o.refundExecution) {
      add("refund", "Authorize Refund", "REFUND", ["reason"]);
    }

    if (o.refundExecution) {
      add("reconcile", "Reconcile Refund");
    }

    if (!o.refundExecution?.providerRefundId) {
      add("recover-refund", "Recover Existing Refund", "RECOVER REFUND", [
        "refundId", "reason",
      ]);
    }

    return actions;
  }

  if (o.type !== "closed_wallet_withdrawal_reversal") return actions;

  if (o.payoutExecution) {
    add("reconcile-payout", "Reconcile Payout");
  }

  if (o.status === "settled") return actions;

  if (!o.payoutExecution) {
    add("payout", "Authorize Payout", "PAYOUT", ["reason"]);
  }

  if (["failed", "reversed"].includes(o.payoutExecution?.state)) {
    add("retry-payout", "Authorize Replacement Payout", "RETRY PAYOUT", ["reason"]);
  }

  if (o.payoutExecution?.state === "otp" && !o.payoutExecution.otpSubmittedAt) {
    add("payout-otp", "Submit Paystack OTP", null, ["otp"]);
  }

  return actions;
}

/* ---------- Whitelisted financial evidence ---------- */

function fields(values) {
  return Object.entries(values)
    .filter(([, value]) => value != null && value !== "")
    .map(([title, value]) => ({ title, value: String(value) }));
}

function executionFields(e) {
  if (!e) return [];

  return fields({
    Status: label(e.state),
    Reference: e.reference,
    "Trace key": e.traceKey,
    "Refund ID": e.providerRefundId,
    "Transfer code": e.transferCode,
    "Authorized by": e.authorizedBy,
    "Authorized at": date(e.authorizedAt),
    Reason: e.reason,
    "Last checked": date(e.lastCheckedAt),
    "OTP submitted at": e.otpSubmittedAt ? date(e.otpSubmittedAt) : null,
  });
}

function settlementFields(s) {
  if (!s) return [];

  return fields({
    Method: label(s.method),
    Reference: s.reference,
    Amount: money(s.amount, s.currency),
    "Refund ID": s.providerRefundId,
    "Confirmed by": s.confirmedBy,
    "Confirmed at": date(s.confirmedAt),
    "Provider status": s.evidence?.status,
    "Transfer code": s.evidence?.transferCode,
    "Provider transaction ID": s.evidence?.transactionId,
    "Provider transfer ID": s.evidence?.providerTransferId,
    "Original reference":
      s.evidence?.originalReference || s.evidence?.originalTransferReference,
  });
}

async function getDetailPage({ adminId, obligationId }) {
  await RefundService.assertAdmin(adminId);

  const o = await FinancialObligation.findById(id(obligationId)).lean();

  if (!o) fail("Financial obligation not found.", 404);

  const item = row(o, await ownersFor([o]));
  const execution = o.refundExecution || o.payoutExecution;

  const history = (o.payoutExecutionHistory || []).map((e, index) => ({
    title: "Payout Attempt " + (index + 1),
    fields: executionFields(e),
    settlement: settlementFields(e.previousSettlement),
  }));

  const timeline = [
    { title: "Original provider outcome verified", at: date(o.verifiedAt) },
    { title: "Obligation recorded", at: date(o.createdAt) },
  ];

  for (const [index, e] of (o.payoutExecutionHistory || []).entries()) {
    timeline.push(
      { title: "Payout attempt " + (index + 1) + " authorized", at: date(e.authorizedAt) },
      { title: "Previous outcome: " + label(e.state), at: date(e.lastCheckedAt) }
    );
  }

  if (execution) {
    timeline.push({
      title: "Current execution authorized",
      at: date(execution.authorizedAt),
    });

    if (execution.lastCheckedAt) {
      timeline.push({
        title: "Latest outcome: " + label(execution.state),
        at: date(execution.lastCheckedAt),
      });
    }
  }

  if (o.settlement) {
    timeline.push({
      title: "Obligation settled",
      at: date(o.settlement.confirmedAt),
    });
  }

  return {
    item,
    environmentMatches: o.providerMode === mode(),
    overview: fields({
      "Obligation ID": o._id,
      Owner: item.owner,
      "Owner ID": item.ownerId,
      "Owner status": item.ownerStatus,
      Environment: label(o.providerMode),
      Amount: item.amount,
      Outstanding: money(o.status === "settled" ? 0 : o.amount, o.currency),
      Reference: o.providerReference,
      "Review reason": o.reviewReason,
    }),

    originalRecords: fields({
      Wallet: o.wallet,
      DVA: o.dva,
      Withdrawal: o.withdrawalTransaction,
      "Commercial receipt": o.commercialTransaction,
      "Subscription payment": o.subscriptionPayment,
      "Job payment": o.jobPayment,
      "Source event": o.sourceProviderEvent,
      "Provider transaction ID": o.providerTransactionId,
      "Provider transfer code": o.providerTransferCode,
      "Verification source": o.verificationSource,
      "Provider status": o.providerStatus,
      "Verified at": date(o.verifiedAt),
    }),

    execution: executionFields(execution),
    settlement: settlementFields(o.settlement),
    previousSettlement: settlementFields(o.payoutExecution?.previousSettlement),
    history,
    timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)),
    actions: actionsFor(o),
  };
}

module.exports = { getListPage, getDetailPage };
