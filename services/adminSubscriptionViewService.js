// services/adminSubscriptionViewService.js

const Subscription = require("../models/Subscription");
const SubscriptionPayment = require("../models/SubscriptionPayment");

const PAGE_SIZE = 30;
const BASE_URL = "/admin/subscriptions";

const SUBSCRIPTION_FIELDS = [
  "referenceCode", "business", "plan", "planSnapshot",
  "status", "activatedAt", "currentPeriodStart",
  "currentPeriodEnd", "renewalCount", "pendingPlanChange",
  "cancelAtPeriodEnd", "cancellationRequestedAt",
  "cancelledAt", "endedAt", "createdAt",
].join(" ");

const PAYMENT_FIELDS = [
  "paymentReference", "paymentKind", "paymentMethod",
  "paymentStatus", "planSnapshot", "providerReference",
  "providerStatus", "paymentTransaction", "periodStart",
  "periodEnd", "paidAt", "appliedAt", "createdAt",
].join(" ");

class AdminSubscriptionViewService {
  /* ───────────────────── HELPERS ───────────────────── */

  static error(message, status = 400) {
    return Object.assign(new Error(message), {
      status,
      statusCode: status,
    });
  }

  static id(value) {
    if (!/^[a-f0-9]{24}$/i.test(String(value || ""))) {
      throw this.error("Invalid record identifier.");
    }

    return String(value);
  }

  static page(value = 1) {
    const page = Number(value);

    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
      throw this.error("Invalid page number.");
    }

    return page;
  }

  static text(value, max = 180) {
    if (value == null) return "";

    if (typeof value !== "string" || value.length > max) {
      throw this.error("Invalid filter.");
    }

    return value.trim();
  }

  static date(value) {
    return value
      ? new Date(value).toLocaleString("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }) + " UTC"
      : "-";
  }

  static price(snapshot = {}) {
    return snapshot.priceMinor == null
      ? "-"
      : snapshot.currency + " " +
        Number(snapshot.priceMinor).toLocaleString("en-GB") +
        " (minor units)";
  }

  static badge(status) {
    return {
      active: "badge-light-success",
      paid: "badge-light-success",
      pending: "badge-light-warning",
      failed: "badge-light-danger",
    }[status] || "badge-light-secondary";
  }

  static outstanding() {
    return {
      $or: [
        { paymentStatus: "pending" },
        { paymentStatus: "paid", appliedAt: null },
      ],
    };
  }

  static attention(now) {
    return {
      $or: [
        { paymentStatus: "pending" },
        {
          paymentStatus: "paid",
          appliedAt: null,
          $or: [
            { paymentKind: { $ne: "renewal" } },
            { periodStart: { $lte: now } },
            { periodStart: null },
          ],
        },
      ],
    };
  }

  static pagination(page, total, url, filters) {
    const link = (number) => {
      const params = new URLSearchParams();

      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }

      params.set("page", String(number));

      return url + "?" + params.toString();
    };

    return {
      page,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
      previousUrl: page > 1 ? link(page - 1) : null,
      nextUrl:
        page * PAGE_SIZE < total && page < 1000
          ? link(page + 1)
          : null,
    };
  }

  /* ───────────────────── DISPLAY PROJECTIONS ───────────────────── */

  static subscriptionView(item, now) {
    const plan = item.planSnapshot || {};
    const benefits = plan.benefits || {};

    const active = Boolean(
      item.status === "active" &&
      item.currentPeriodStart &&
      item.currentPeriodEnd &&
      item.currentPeriodStart <= now &&
      now < item.currentPeriodEnd
    );

    return {
      id: String(item._id),
      reference: item.referenceCode,
      businessId: String(item.business?._id || item.business || ""),
      businessName: item.business?.businessName || "Business record",
      planName: plan.name || "-",
      planCode: plan.code || "-",
      version: plan.version || "-",
      market: (plan.countryCode || "-") + " / " + (plan.currency || "-"),
      price: this.price(plan),
      cycle: plan.billingCycle || "-",
      status: item.status,
      badge: this.badge(item.status),
      entitlement: active ? "Active paid period" : "No active paid period",
      start: this.date(item.currentPeriodStart),
      end: this.date(item.currentPeriodEnd),
      endedAt: this.date(item.endedAt),
      renewalCount: item.renewalCount || 0,
      purchasedSlots: benefits.activeJobSlots || 0,
      effectiveSlots: active ? benefits.activeJobSlots || 0 : 0,
      fee: benefits.basePlatformFeeRate == null
        ? "Standard fee"
        : (benefits.basePlatformFeeRate * 100).toFixed(2) + "%",
      features: benefits.featureKeys || [],
      cancellation: item.cancelAtPeriodEnd ? "Scheduled" : "No",
      cancellationRequestedAt: this.date(item.cancellationRequestedAt),
      pendingChange: item.pendingPlanChange
        ? {
            type: item.pendingPlanChange.changeType,
            target: item.pendingPlanChange.targetPlanSnapshot?.name || "-",
            reference: item.pendingPlanChange.paymentReference,
          }
        : null,
      url: BASE_URL + "/" + item._id,
    };
  }

  static paymentView(item, now) {
    const scheduled =
      item.paymentStatus === "paid" &&
      !item.appliedAt &&
      item.paymentKind === "renewal" &&
      item.periodStart &&
      item.periodStart > now;

    return {
      reference: item.paymentReference,
      kind: item.paymentKind,
      method: item.paymentMethod,
      status: item.paymentStatus,
      badge: this.badge(item.paymentStatus),
      plan: item.planSnapshot?.name || "-",
      amount: this.price(item.planSnapshot),
      application: item.appliedAt
        ? "Applied"
        : scheduled
          ? "Scheduled"
          : item.paymentStatus === "paid"
            ? "Awaiting application"
            : item.paymentStatus === "pending"
              ? "Awaiting confirmation"
              : "-",
      providerReference: item.providerReference || "-",
      providerStatus: item.providerStatus || "-",
      transactionId: String(item.paymentTransaction || "-"),
      created: this.date(item.createdAt),
      paid: this.date(item.paidAt),
      applied: this.date(item.appliedAt),
      start: this.date(item.periodStart),
      end: this.date(item.periodEnd),
    };
  }

  /* ───────────────────── REGISTER ───────────────────── */

  static async list(query = {}) {
    const now = new Date();
    const page = this.page(query.page ?? 1);

    const filters = {
      status: this.text(query.status, 20),
      reference: this.text(query.reference),
      businessId: this.text(query.businessId, 24),
    };

    const filter = {};

    if (filters.status) {
      if (!["pending", "active", "cancelled", "expired"].includes(filters.status)) {
        throw this.error("Invalid subscription status.");
      }

      filter.status = filters.status;
    }

    if (filters.reference) {
      filter.referenceCode = filters.reference.toUpperCase();
    }

    if (filters.businessId) {
      filter.business = this.id(filters.businessId);
    }

    const [records, total] = await Promise.all([
      Subscription.find(filter)
        .select(SUBSCRIPTION_FIELDS)
        .populate("business", "businessName")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),

      Subscription.countDocuments(filter),
    ]);

    const counts = await SubscriptionPayment.aggregate([
      {
        $match: {
          subscription: { $in: records.map((item) => item._id) },
          ...this.attention(now),
        },
      },
      { $group: { _id: "$subscription", count: { $sum: 1 } } },
    ]);

    const countMap = new Map(
      counts.map((item) => [String(item._id), item.count])
    );

    return {
      filters,
      subscriptions: records.map((item) => ({
        ...this.subscriptionView(item, now),
        attention: countMap.get(String(item._id)) || 0,
      })),
      pagination: this.pagination(page, total, BASE_URL, filters),
    };
  }

  /* ───────────────────── DETAILS ───────────────────── */

  static async details(subscriptionId, query = {}) {
    const now = new Date();
    const page = this.page(query.page ?? 1);

    const paymentFilter = this.text(query.paymentFilter, 20);

    if (!["", "outstanding", "attention"].includes(paymentFilter)) {
      throw this.error("Invalid payment filter.");
    }

    const record = await Subscription.findById(this.id(subscriptionId))
      .select(SUBSCRIPTION_FIELDS + " planChangeHistory")
      .populate("business", "businessName")
      .lean();

    if (!record) {
      throw this.error("Subscription not found.", 404);
    }

    const scope = { subscription: record._id };

    const filter = {
      ...scope,
      ...(paymentFilter === "outstanding"
        ? this.outstanding()
        : paymentFilter === "attention"
          ? this.attention(now)
          : {}),
    };

    const [payments, total, outstanding, attention] = await Promise.all([
      SubscriptionPayment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),

      SubscriptionPayment.countDocuments(filter),

      SubscriptionPayment.countDocuments({
        ...scope,
        ...this.outstanding(),
      }),

      SubscriptionPayment.countDocuments({
        ...scope,
        ...this.attention(now),
      }),
    ]);

    const history = record.planChangeHistory || [];

    return {
      subscription: this.subscriptionView(record, now),
      payments: payments.map((item) => this.paymentView(item, now)),
      paymentFilter,
      outstanding,
      attention,
      historyCount: history.length,

      history: history.slice(-50).reverse().map((item) => ({
        type: item.changeType,
        from: String(item.fromPlan),
        to: String(item.toPlan),
        reference: item.paymentReference,
        effective: this.date(item.effectiveAt),
        applied: this.date(item.appliedAt),
        retained: item.retainedPublicationIds?.length || 0,
      })),

      pagination: this.pagination(
        page,
        total,
        BASE_URL + "/" + record._id,
        { paymentFilter }
      ),
    };
  }
}

module.exports = AdminSubscriptionViewService;
