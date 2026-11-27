// services/businessClosureService.js

const mongoose = require("mongoose");

const User = require("../models/User");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");

const ProviderEvent = require("../models/ProviderEvent");
const DVA = require("../models/DVA");

const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const Appointment = require("../models/Appointment");
const JobPublication = require("../models/JobPublication");
const JobPayment = require("../models/JobPayment");
const Subscription = require("../models/Subscription");
const SubscriptionPayment = require("../models/SubscriptionPayment");
const { TERMINAL_APPLICATION_STATUSES } = require("../constants/shiftApplication");
const { TERMINAL_JOB_APPLICATION_STATUSES } = require("../constants/jobApplication");
const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftOccurrence = require("../models/ShiftOccurrence");

const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");

const ShiftSettlementBatch = require("../models/ShiftSettlementBatch");
const EmployerRefund = require("../models/EmployerRefund");
const EmployerRefundBatch = require("../models/EmployerRefundBatch");

const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const FinancialObligationService = require("./financialObligationService");

const WalletService = require("./walletService");
const DVAService = require("./dvaService");
const BranchService = require("./branchService");
const InviteService = require("./inviteService");
const TeamMemberService = require("./teamMemberService");
const { createServiceError } = require("./helpers/serviceErrorHelper");

async function readClosureQueries(session, queries) {
  if (!session) return Promise.all(queries);
  const results = [];
  for (const query of queries) results.push(await query.session(session));
  return results;
}

class BusinessClosureService {
  static async getBusinessClosureEligibility({
    businessId,
    requestingUserId,
    session = null,
  } = {}) {
    if (!mongoose.isValidObjectId(businessId) || !mongoose.isValidObjectId(requestingUserId)) {
      throw new Error("A valid business and requesting user are required.");
    }

    const [user, business] = await readClosureQueries(session, [
      User.findById(requestingUserId).select("_id role accountStatus isVerified").lean(),

      EmployerProfile.findById(businessId)
        .select("_id user businessName accountStatus closureStartedAt closedAt")
        .lean(),
    ]);

    if (
      !user ||
      !business ||
      user.role !== "employer" ||
      user.accountStatus !== "active" ||
      user.isVerified !== true ||
      String(business.user) !== String(user._id)
    ) {
      throw new Error("You are not authorized to close this business.");
    }

    const blockers = [];

    const pendingChecks = [];

    const addBlocker = (code, message) => {
      blockers.push({ code, message });
    };

    if (!["active", "closing"].includes(business.accountStatus)) {
      addBlocker(
        "BUSINESS_CLOSURE_STATUS_INELIGIBLE",
        "This business cannot use the standard closure process in its current status."
      );
    }

    const [
      unresolvedShift,
      ongoingAssignment,
      unresolvedOccurrence,
      openAssignmentCase,
      activeClaim,
      activeDispute,
      unresolvedSettlementBatch,
      unresolvedRefund,
      unresolvedRefundBatch,
      wallets,
      currentMemberCount,
    ] = await readClosureQueries(session, [
      Shift.exists({
        business: business._id,
        status: {
          $nin: ["completed", "cancelled"],
        },
      }),

      ShiftAssignment.exists({
        business: business._id,
        status: {
          $in: ["scheduled", "active", "ending"],
        },
      }),

      ShiftOccurrence.exists({
        business: business._id,
        $or: [
          {
            status: {
              $nin: ["completed", "cancelled", "no_show", "expired_unfilled"],
            },
          },
          {
            settlementStatus: {
              $nin: ["released", "not_due"],
            },
          },
          {
            refundStatus: {
              $nin: ["not_eligible", "refunded"],
            },
          },
          {
            activeClaim: { $ne: null },
          },
          {
            activeDispute: { $ne: null },
          },
          {
            challengeDeadlineAt: { $gt: new Date() },
            challengeWindowClosedAt: null,
          },
        ],
      }),

      ShiftAssignmentCase.exists({
        business: business._id,
        isOpen: true,
      }),

      ShiftOccurrenceClaim.exists({
        business: business._id,
        status: "active",
      }),

      ShiftOccurrenceDispute.exists({
        business: business._id,
        status: "active",
      }),

      ShiftSettlementBatch.exists({
        "lines.business": business._id,
        status: {
          $nin: ["released", "cancelled"],
        },
      }),

      EmployerRefund.exists({
        business: business._id,
        $or: [
          {
            status: {
              $nin: ["refunded", "voided"],
            },
          },
          {
            reservationStatus: {
              $ne: "released",
            },
          },
        ],
      }),

      EmployerRefundBatch.exists({
        business: business._id,
        status: {
          $nin: ["completed", "cancelled"],
        },
      }),

      Wallet.find({
        ownerType: "employer",
        employer: business._id,
      })
        .select("_id status availableBalance pendingBalance outstandingBalance")
        .lean(),

      EmployerMember.countDocuments({
        business: business._id,
        isCurrent: true,
      }),
    ]);

    const [
      openShiftApplications,
      activeJob,
      activeJobApplication,
      scheduledAppointment,
      activePublication,
      unresolvedJobPayment,
      unusedPaidEntitlement,
    ] = await readClosureQueries(session, [
      Shift.aggregate([
        { $match: { business: business._id } },
        { $project: { _id: 1 } },
        {
          $lookup: {
            from: ShiftApplication.collection.name,
            let: { shiftId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$shift", "$$shiftId"] },
                  status: { $nin: TERMINAL_APPLICATION_STATUSES },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: "openApplications",
          },
        },
        { $match: { "openApplications.0": { $exists: true } } },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ]),
      Job.exists({
        business: business._id,
        $or: [{ recruitmentStatus: "active" }, { publicationStatus: { $in: ["live", "paused"] } }],
      }),
      JobApplication.exists({
        business: business._id,
        status: { $nin: TERMINAL_JOB_APPLICATION_STATUSES },
      }),
      Appointment.exists({ business: business._id, status: "scheduled" }),
      JobPublication.exists({ business: business._id, status: { $in: ["live", "paused"] } }),
      JobPayment.exists({
        business: business._id,
        $or: [
          { paymentStatus: { $nin: ["paid", "failed", "cancelled", "refunded"] } },
          { providerStatus: "pending" },
        ],
      }),
      JobPayment.exists({ business: business._id, paymentStatus: "paid", consumedAt: null }),
    ]);

    if (openShiftApplications.length) {
      addBlocker(
        "BUSINESS_CLOSURE_OPEN_SHIFT_APPLICATIONS",
        "Resolve outstanding shift applications before closing this business."
      );
    }
    if (activeJob) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_RECRUITMENT",
        "Close active recruitment and job listings before business closure."
      );
    }
    if (activeJobApplication) {
      addBlocker(
        "BUSINESS_CLOSURE_OPEN_JOB_APPLICATIONS",
        "Resolve outstanding permanent job applications before business closure."
      );
    }
    if (scheduledAppointment) {
      addBlocker(
        "BUSINESS_CLOSURE_OPEN_JOB_APPOINTMENTS",
        "Resolve all scheduled interviews before business closure."
      );
    }
    if (activePublication) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_JOB_PUBLICATIONS",
        "End live or paused job publications before business closure."
      );
    }
    if (unresolvedJobPayment) {
      addBlocker(
        "BUSINESS_CLOSURE_PENDING_JOB_PAYMENTS",
        "Resolve outstanding job publication payments before business closure."
      );
    }
    if (unusedPaidEntitlement) {
      addBlocker(
        "BUSINESS_CLOSURE_UNUSED_JOB_ENTITLEMENT",
        "Resolve unused paid job publication entitlements before closure."
      );
    }

    const [activeSubscription, unresolvedSubscriptionPayment] = await readClosureQueries(session, [
      Subscription.exists({
        business: business._id,
        $or: [{ status: "active" }, { pendingPlanChange: { $ne: null } }],
      }),
      SubscriptionPayment.exists({
        business: business._id,
        $or: [
          { paymentStatus: { $nin: ["paid", "failed", "cancelled", "refunded"] } },
          { paymentStatus: "paid", appliedAt: null },
          { providerStatus: "pending" },
        ],
      }),
    ]);

    if (activeSubscription) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_SUBSCRIPTION",
        "End the active subscription and resolve any plan change before closure."
      );
    }
    if (unresolvedSubscriptionPayment) {
      addBlocker(
        "BUSINESS_CLOSURE_PENDING_SUBSCRIPTION_PAYMENT",
        "Reconcile pending or unapplied subscription payments before closure."
      );
    }

    if (unresolvedShift) {
      addBlocker(
        "BUSINESS_CLOSURE_UNRESOLVED_SHIFTS",
        "Resolve outstanding shifts before closing this business."
      );
    }

    if (ongoingAssignment) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_ASSIGNMENTS",
        "The business still has scheduled, active or ending assignments."
      );
    }

    if (unresolvedOccurrence) {
      addBlocker(
        "BUSINESS_CLOSURE_UNRESOLVED_OCCURRENCES",
        "One or more shift occurrences have unresolved operational or financial obligations."
      );
    }

    if (openAssignmentCase) {
      addBlocker(
        "BUSINESS_CLOSURE_OPEN_ASSIGNMENT_CASES",
        "The business has unresolved assignment cases."
      );
    }

    if (activeClaim) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_CLAIMS",
        "The business has unresolved professional claims."
      );
    }

    if (activeDispute) {
      addBlocker(
        "BUSINESS_CLOSURE_ACTIVE_DISPUTES",
        "The business has unresolved employer disputes."
      );
    }

    if (unresolvedSettlementBatch) {
      addBlocker(
        "BUSINESS_CLOSURE_PENDING_SETTLEMENTS",
        "Professional settlement batches involving this business remain unresolved."
      );
    }

    if (unresolvedRefund) {
      addBlocker(
        "BUSINESS_CLOSURE_PENDING_REFUNDS",
        "The business has outstanding refund obligations or escrow reservations."
      );
    }

    if (unresolvedRefundBatch) {
      addBlocker(
        "BUSINESS_CLOSURE_UNRECONCILED_REFUND_BATCHES",
        "Employer refund batches require completion or financial reconciliation."
      );
    }

    if (
      wallets.some(
        (wallet) =>
          wallet.availableBalance !== 0 ||
          wallet.pendingBalance !== 0 ||
          wallet.outstandingBalance !== 0
      )
    ) {
      addBlocker(
        "BUSINESS_CLOSURE_WALLET_BALANCE",
        "Clear all available, pending and outstanding wallet balances before closure."
      );
    }

    if (wallets.some((wallet) => wallet.status === "frozen")) {
      addBlocker(
        "BUSINESS_CLOSURE_FROZEN_WALLET",
        "A frozen business wallet requires financial review."
      );
    }

    if (
      await FinancialObligationService.hasOutstandingObligations(
        {
          employerProfileId: business._id,
        },
        { session }
      )
    ) {
      addBlocker(
        "BUSINESS_CLOSURE_OUTSTANDING_FINANCIAL_OBLIGATIONS",
        "Resolve outstanding financial obligations before closing this business."
      );
    }

    const walletIds = wallets.map((wallet) => wallet._id);

    const dvas = await DVA.find({
      employer: business._id,
    })
      .select(
        "_id status paystackCustomerId paystackCustomerCode paystackDedicatedAccountId accountNumber bankId bankCode bankSlug providerSlug metadata"
      )
      .session(session)
      .lean();

    const dvaIds = dvas.map((dva) => dva._id);

    const providerEventScopes = [
      {
        employer: business._id,
      },
    ];

    if (walletIds.length > 0) {
      providerEventScopes.push({
        wallet: { $in: walletIds },
      });

      const withdrawalReferences = await Transaction.distinct("paystackTransferReference", {
        wallet: { $in: walletIds },
        type: "withdrawal",
        provider: "paystack",
        paymentRail: "paystack_transfer",
        paystackTransferReference: { $type: "string" },
      }).session(session);

      if (withdrawalReferences.length > 0) {
        providerEventScopes.push({
          provider: "paystack",
          providerReference: { $in: withdrawalReferences },
        });
      }
    }

    if (dvaIds.length > 0) {
      providerEventScopes.push({
        dva: { $in: dvaIds },
      });
    }

    // Include verified events that have not yet acquired
    // their original DVA link.

    for (const dva of dvas) {
      const identities = [];

      for (const field of [
        "paystackCustomerId",
        "paystackCustomerCode",
        "paystackDedicatedAccountId",
      ]) {
        const value = dva[field];

        if (value != null && value !== "") {
          identities.push({
            ["normalizedPayload." + field]: {
              $in: [value, String(value)],
            },
          });
        }
      }

      if (dva.accountNumber) {
        for (const field of ["bankId", "bankCode", "bankSlug", "providerSlug"]) {
          if (dva[field] != null && dva[field] !== "") {
            identities.push({
              "normalizedPayload.accountNumber": dva.accountNumber,

              ["normalizedPayload." + field]: {
                $in: [dva[field], String(dva[field])],
              },
            });
          }
        }
      }

      if (identities.length) {
        providerEventScopes.push({
          provider: "paystack",

          eventCategory: {
            $in: ["dva_assignment", "employer_wallet_funding"],
          },

          $or: identities,
        });
      }

      const email = dva.metadata?.assignmentEmail || dva.metadata?.requestedWith?.email;

      if (email) {
        providerEventScopes.push({
          provider: "paystack",

          eventCategory: "dva_assignment",

          "normalizedPayload.customerEmail": String(email).trim().toLowerCase(),
        });
      }
    }

    // Include commercial receipts not yet linked to the business.
    const [jobRefs, subscriptionRefs] = await readClosureQueries(session, [
      JobPayment.distinct("providerReference", {
        business: business._id,
        providerReference: { $type: "string" },
      }),
      SubscriptionPayment.distinct("providerReference", {
        business: business._id,
        providerReference: { $type: "string" },
      }),
    ]);

    const commercialRefs = [...new Set([...jobRefs, ...subscriptionRefs])];

    if (commercialRefs.length) {
      providerEventScopes.push({
        provider: "paystack",
        providerReference: { $in: commercialRefs },
      });
    }

    const unresolvedProviderEvent = await ProviderEvent.exists({
      isVerified: true,

      eventCategory: {
        $in: [
          "employer_wallet_funding",
          "shift_checkout_payment",
          "job_publication_purchase",
          "subscription_payment",
          "employer_refund",
          "dva_assignment",
          "transfer_unresolved",
          "employer_withdrawal_payout",
          "employer_withdrawal_reversal",
        ],
      },

      status: {
        $nin: ["processed"],
      },

      $or: providerEventScopes,
    }).session(session);

    if (unresolvedProviderEvent) {
      addBlocker(
        "BUSINESS_CLOSURE_UNRECONCILED_PROVIDER_EVENTS",
        "The business has verified payment provider events requiring reconciliation before closure."
      );
    }

    if (walletIds.length > 0) {
      const pendingTransaction = await Transaction.exists({
        status: {
          $in: ["pending", "processing"],
        },
        $or: [
          {
            wallet: { $in: walletIds },
          },
          {
            counterpartyWallet: { $in: walletIds },
          },
        ],
      }).session(session);

      if (pendingTransaction) {
        addBlocker(
          "BUSINESS_CLOSURE_PENDING_TRANSACTIONS",
          "The business has financial transactions that are pending or processing."
        );
      }
    }

    return {
      businessId: String(business._id),
      businessName: business.businessName,
      accountStatus: business.accountStatus,
      closureStartedAt: business.closureStartedAt || null,
      ownerId: String(business.user),
      currentMemberCount,
      walletCount: wallets.length,
      dvaCount: dvas.length,
      blockers,
      pendingChecks,
      canClose: blockers.length === 0 && pendingChecks.length === 0,
    };
  }

  /* ---------- BUSINESS CLOSURE ---------- */

  static async lockBusinessForClosure({ businessId, requestingUserId, session }) {
    const actor = await User.findOneAndUpdate(
      {
        _id: requestingUserId,
        role: "employer",
        accountStatus: "active",
        isVerified: true,
      },
      { $inc: { __v: 1 } },
      { session, new: true }
    ).select("_id");

    if (!actor)
      throw createServiceError({
        name: "BusinessClosureServiceError",
        code: "BUSINESS_CLOSURE_FORBIDDEN",
        message: "An active verified business owner is required.",
        statusCode: 403,
      });

    const business = await EmployerProfile.findOneAndUpdate(
      {
        _id: businessId,
        user: actor._id,
        accountStatus: { $in: ["active", "closing"] },
      },
      { $inc: { __v: 1 } },
      { session, new: true }
    );

    if (business) return business;

    const closed = await EmployerProfile.findOne({
      _id: businessId,
      user: actor._id,
      accountStatus: "closed",
    }).session(session);

    if (closed) return closed;

    throw createServiceError({
      name: "BusinessClosureServiceError",
      code: "BUSINESS_CLOSURE_FORBIDDEN",
      message: "Only the owner of an eligible business may close it.",
      statusCode: 403,
    });
  }

  static async assertClosureEligible({ businessId, requestingUserId, session }) {
    const eligibility = await this.getBusinessClosureEligibility({
      businessId,
      requestingUserId,
      session,
    });

    if (!eligibility.canClose)
      throw createServiceError({
        name: "BusinessClosureServiceError",
        code: "BUSINESS_CLOSURE_BLOCKED",
        message: "Resolve outstanding business commitments before closure.",
        statusCode: 409,
        details: { eligibility },
      });

    return eligibility;
  }

  static async closeBusiness({ businessId, requestingUserId, confirmed = false } = {}) {
    if (
      confirmed !== true ||
      !mongoose.isValidObjectId(businessId) ||
      !mongoose.isValidObjectId(requestingUserId)
    ) {
      throw createServiceError({
        name: "BusinessClosureServiceError",
        code: "BUSINESS_CLOSURE_CONFIRMATION_REQUIRED",
        message: "Valid business ownership and explicit closure confirmation are required.",
        statusCode: 400,
      });
    }

    const ownership = { businessId, requestingUserId };

    const prepared = await WalletService.runWithOptionalTransaction({}, async (session) => {
      const business = await this.lockBusinessForClosure({ ...ownership, session });

      if (business.accountStatus === "closed") {
        return { alreadyClosed: true, closedAt: business.closedAt };
      }

      await this.assertClosureEligible({ ...ownership, session });

      if (business.accountStatus === "active") {
        const startedAt = new Date();

        business.accountStatus = "closing";
        business.closureStartedAt = startedAt;
        business.accountStatusReason = "Business owner requested closure";
        business.accountStatusUpdatedAt = startedAt;
        business.accountStatusUpdatedBy = requestingUserId;
        business.$locals.businessClosureTransition = true;

        await business.save({ session });
      }

      const dvas = await DVA.find({ employer: business._id }).session(session);
      const identities = [];

      for (const dva of dvas) {
        const identity = {
          dvaId: dva._id,
          employerProfileId: business._id,
          walletId: dva.wallet,
        };

        await DVAService.beginEmployerDVARetirement({ ...identity, session });
        identities.push(identity);
      }

      return { identities };
    });

    if (prepared.alreadyClosed) {
      return {
        businessId: String(businessId),
        closed: true,
        idempotent: true,
        closedAt: prepared.closedAt,
      };
    }

    // Provider calls run outside MongoDB transactions.
    for (const identity of prepared.identities) {
      await DVAService.confirmEmployerDVARetirement(identity);
    }

    return WalletService.runWithOptionalTransaction({}, async (session) => {
      const business = await this.lockBusinessForClosure({ ...ownership, session });

      if (business.accountStatus === "closed") {
        return {
          businessId: String(businessId),
          closed: true,
          idempotent: true,
          closedAt: business.closedAt,
        };
      }

      if (business.accountStatus !== "closing" || !business.closureStartedAt) {
        throw createServiceError({
          name: "BusinessClosureServiceError",
          code: "BUSINESS_CLOSURE_NOT_STARTED",
          message: "Business closure must be initiated before finalization.",
          statusCode: 409,
        });
      }

      await this.assertClosureEligible({ ...ownership, session });

      const dvas = await DVA.find({ employer: business._id }).session(session);

      for (const dva of dvas) {
        if (!["retiring", "deactivated"].includes(dva.status) || !dva.retirementConfirmedAt) {
          throw createServiceError({
            name: "BusinessClosureServiceError",
            code: "BUSINESS_CLOSURE_DVA_UNCONFIRMED",
            message: "DVA retirement is not confirmed. Retry closure after reconciliation.",
            statusCode: 409,
            retryable: true,
          });
        }
      }

      const wallets = await Wallet.find({
        ownerType: "employer",
        employer: business._id,
      }).session(session);

      for (const wallet of wallets) {
        await WalletService.closeWalletForAccountClosure(
          {
            walletId: wallet._id,
            ownerType: "employer",
            ownerProfileId: business._id,
          },
          { session }
        );
      }

      for (const dva of dvas) {
        await DVAService.finalizeEmployerDVARetirement({
          dvaId: dva._id,
          employerProfileId: business._id,
          walletId: dva.wallet,
          session,
        });
      }

      const closedAt = new Date();

      business.accountStatus = "closed";
      business.closedAt = closedAt;
      business.accountStatusReason = "Business owner requested closure";
      business.accountStatusUpdatedAt = closedAt;
      business.accountStatusUpdatedBy = requestingUserId;

      business.$locals.businessClosureTransition = true;
      await business.save({ session });

      const offboarding = {
        businessId: business._id,
        actorUserId: requestingUserId,
        session,
      };

      await BranchService.deactivateForBusinessClosure(offboarding);
      await InviteService.revokeForBusinessClosure(offboarding);
      await TeamMemberService.removeForBusinessClosure(offboarding);

      return {
        businessId: String(business._id),
        closed: true,
        idempotent: false,
        closedAt,
      };
    });
  }
}

module.exports = BusinessClosureService;
