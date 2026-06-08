// models/Shift.js

const mongoose = require("mongoose");

/**
 * PAYMENT ARCHITECTURE:
 * Loqum uses a Protected Shift payment flow.
 *
 * Employer pays:
 * professional approved pay + Loqum platform fee.
 *
 * PLATFORM FEE:
 * The employer pays Loqum's platform fee on top of the professional's
 * approved pay.
 *
 * The active platform fee should be read from PlatformSettings when the shift
 * is posted and the employer is shown the estimated charge.
 *
 * The selected rate is snapshotted into this shift as platformFeeRate, so the
 * employer keeps the same fee for that shift even if Loqum changes pricing later.
 *
 * Professional receives:
 * agreed/approved professional pay.
 * No pharmacist-side commission deduction at launch.
 *
 * Shift confirmation rule:
 * A shift is not confirmed until the employer funds it.
 *
 * FUNDING OPTIONS:
 *
 * 1. Fund from Wallet:
 *    Employer uses existing wallet availableBalance to fund the shift.
 *    Employer wallet availableBalance is debited.
 *    Protected Shift balance is credited.
 *
 * 2. Pay with Paystack:
 *    Employer pays through Paystack Checkout.
 *    Once Paystack confirms payment, Loqum credits the Protected Shift balance.
 *
 * DVA:
 * DVA is the Paystack-powered inbound rail for employer wallet top-ups.
 * It is not the wallet.
 * It should not directly fund a shift.
 *
 * DVA deposits should only top up the employer wallet.
 * They should not automatically fund any shift.
 *
 * Flow:
 * Employer wallet or Paystack Checkout
 * -> Protected Shift balance
 * -> Professional payout after completion and clearance
 * -> Loqum platform fee recorded separately
 *
 * ATTENDANCE:
 * Both PINs are generated at shift creation.
 * Check-in PIN is visible to the employer shortly before start time.
 * Check-out PIN is revealed to the employer only after successful check-in.
 *
 * No valid check-in means no automatic settlement.
 * No check-out means settlement requires employer confirmation or admin fallback.
 * Late check-out does not automatically mean paid overtime.
 * If the professional checks out after endTime, the UI should ask whether they
 * are only checking out late or requesting overtime.
 */

const shiftSchema = new mongoose.Schema(
  {
    // --- CORE IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      // e.g. LQM-8821
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // owner, admin, or branch manager who posted the shift
    },

    department: {
      type: String,
      trim: true,
      // e.g. "Community Pharmacy", "Emergency Ward"
    },

    roleTitle: {
      type: String,
      trim: true,
      required: true,
      // e.g. "Locum Pharmacist", "Staff Nurse"
    },

    professionalType: {
      type: String,
      enum: [
        "pharmacist",
        "pharmacy_technician",
        "nurse",
        "doctor",
        "lab_scientist",
        "radiographer",
        "physiotherapist",
      ],
      required: true,
    },

    // --- TIME & LOGISTICS ---

    startTime: {
      type: Date,
      required: true,
    },

    endTime: {
      type: Date,
      required: true,
    },

    scheduledHours: {
      type: Number,
      default: null,
      // Service layer should calculate this from startTime and endTime.
      // Example: 8.00
    },

    breakDuration: {
      type: Number,
      default: 0,
      // In minutes.
      // Informational only for now.
      // Not deducted automatically from settlement.
    },

    baseBillableHours: {
      type: Number,
      default: null,
      // Approved non-overtime hours.
      // Usually capped at scheduledHours unless shift ends early.
    },

    billableHours: {
      type: Number,
      default: null,
      // Final approved payable hours.
      // This may include approved overtime.
    },

    // --- FINANCIALS ---

    hourlyRate: {
      type: Number,
      required: true,
      // In Naira.
      // Example: 4000.00
    },

    platformFeeRate: {
      type: Number,
      default: null,
      min: 0,
      max: 1,
      // Snapshotted from PlatformSettings when the shift is posted.
      // Example: 0.075 means 7.50%.
      // This preserves the exact fee used for this shift,
      // even if Loqum changes the global fee later.
    },

    pricingLockedAt: {
      type: Date,
      default: null,
      // Set when the shift is posted and the employer is shown the estimated charge.
      // After this point, platformFeeRate and estimated charge fields should not
      // change except through a controlled admin correction flow.
    },

    pricingLockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      // User who posted the shift and caused pricing to be locked.
    },

    estimatedProfessionalPay: {
      type: Number,
      default: null,
      // scheduledHours * hourlyRate.
      // This is what the professional is expected to earn before the shift happens.
    },

    estimatedPlatformFee: {
      type: Number,
      default: null,
      // estimatedProfessionalPay * platformFeeRate.
    },

    estimatedEmployerCharge: {
      type: Number,
      default: null,
      // estimatedProfessionalPay + estimatedPlatformFee.
      // This is what the employer must fund before the shift is confirmed.
    },

    fundedAmount: {
      type: Number,
      default: 0,
      // Amount actually credited to this shift's Protected Shift balance.
      // Can come from employer wallet or Paystack Checkout.
    },

    baseProfessionalPay: {
      type: Number,
      default: null,
      // Pay for approved scheduled/base hours only.
      // This excludes overtime.
    },

    basePlatformFee: {
      type: Number,
      default: null,
      // Platform fee on baseProfessionalPay using this shift's platformFeeRate.
    },

    baseEmployerCharge: {
      type: Number,
      default: null,
      // baseProfessionalPay + basePlatformFee.
    },

    overtimeProfessionalPay: {
      type: Number,
      default: null,
      // Pay for approved overtime only.
    },

    overtimePlatformFee: {
      type: Number,
      default: null,
      // Platform fee on approved overtimeProfessionalPay using this shift's platformFeeRate.
    },

    overtimeEmployerCharge: {
      type: Number,
      default: null,
      // overtimeProfessionalPay + overtimePlatformFee.
    },

    finalProfessionalPay: {
      type: Number,
      default: null,
      // Final amount the professional should receive.
      // baseProfessionalPay + approved overtimeProfessionalPay.
    },

    finalPlatformFee: {
      type: Number,
      default: null,
      // Final Loqum fee earned on the shift.
      // basePlatformFee + approved overtimePlatformFee.
    },

    finalEmployerCharge: {
      type: Number,
      default: null,
      // finalProfessionalPay + finalPlatformFee.
    },

    topUpRequired: {
      type: Number,
      default: 0,
      // Extra amount employer must pay if approved finalEmployerCharge exceeds fundedAmount.
    },

    refundedAmount: {
      type: Number,
      default: 0,
      // Unused funded amount returned to employer wallet if finalEmployerCharge is lower.
    },

    // --- PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: [
        "unpaid",
        // Shift has not been funded.

        "funded",
        // Employer has funded the estimatedEmployerCharge.
        // Shift can now be confirmed.

        "base_release_pending",
        // Base shift pay is ready for release after checkout/completion checks.

        "base_released",
        // Base pay has been released but overtime may still be unresolved.

        "awaiting_overtime_review",
        // Overtime was requested and employer must approve, reject, or dispute.

        "awaiting_topup",
        // Overtime or extra approved cost requires employer top-up.

        "released",
        // All cleared professional payout has been released.

        "failed",
        // Funding, top-up, payout, refund, or settlement failed and needs retry.

        "refunded",
        // Full funded amount returned to employer.

        "partially_refunded",
        // Part of funded amount returned to employer.
      ],
      default: "unpaid",
    },

    // --- TRANSACTION REFERENCES ---

    fundingTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Employer funding transaction for the original estimatedEmployerCharge.
      // Can represent Fund from Wallet or Pay with Paystack.
    },

    topUpTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Employer top-up transaction, usually for approved overtime.
      // Can represent wallet funding or Paystack Checkout funding.
    },

    refundTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Refund transaction back to employer wallet where applicable.
    },

    payoutTransactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
        // Professional payout transaction records.
        // More than one is allowed because base pay and overtime pay may be released separately.
      },
    ],

    platformFeeTransactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
        // Loqum fee transaction records.
        // More than one is allowed if base fee and overtime fee are recorded separately.
      },
    ],

    // --- PROFESSIONAL ASSIGNMENT ---

    assignedProfessional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      // Employer user who accepted or selected the professional.
    },

    // --- APPLICATIONS ---

    totalApplications: {
      type: Number,
      default: 0,
    },

    // --- SHIFT STATUS ---

    status: {
      type: String,
      enum: [
        "open",
        // Visible and accepting applications.

        "assigned",
        // Professional selected, but payment not funded yet.

        "confirmed",
        // Employer has funded the shift. Shift is now secured.

        "in_progress",
        // Professional has checked in.

        "pending_settlement",
        // Professional has checked out or shift needs completion review.

        "completed",
        // Cleared and paid out.

        "cancelled",
        // Cancelled before completion.

        "disputed",
        // Conflict raised. Relevant funds are held pending review.

        "no_show",
        // Professional did not check in within the allowed window.
      ],
      default: "open",
    },

    // --- PINS ---

    checkInPin: {
      type: String,
      default: null,
      // Generated at shift creation.
      // Visible to employer shortly before start time only.
      // Never exposed to the professional.
    },

    checkOutPin: {
      type: String,
      default: null,
      // Generated at shift creation.
      // Revealed to employer only after successful check-in.
      // Professional enters it when leaving.
    },

    // --- ATTENDANCE ---

    attendanceStatus: {
      type: String,
      enum: [
        "not_started",
        "checked_in",
        "checked_out",
        "missed_checkin_review",
        "checkout_fallback_review",
        "disputed",
        "settled",
      ],
      default: "not_started",
    },

    checkedInAt: {
      type: Date,
      default: null,
    },

    checkedOutAt: {
      type: Date,
      default: null,
    },

    checkInLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      capturedAt: { type: Date, default: null },

      distanceFromBranchMeters: { type: Number, default: null },
      withinAllowedRadius: { type: Boolean, default: null },
    },

    checkOutLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      capturedAt: { type: Date, default: null },

      distanceFromBranchMeters: { type: Number, default: null },
      withinAllowedRadius: { type: Boolean, default: null },
    },

    // --- LATE CHECKOUT ---
    // A late checkout is not the same as overtime.
    // Late checkout simply means checkedOutAt is after endTime.
    // The professional must intentionally request overtime if they want extra pay.

    lateCheckout: {
      occurred: { type: Boolean, default: false },

      minutesLate: {
        type: Number,
        default: 0,
      },

      selectedOption: {
        type: String,
        enum: ["normal_late_checkout", "overtime_requested", null],
        default: null,
        // normal_late_checkout means the professional is only clocking out late.
        // overtime_requested means the professional says they worked approved extra time.
      },

      reason: {
        type: String,
        enum: [
          "forgot_to_checkout",
          "handover_delay",
          "system_issue",
          "worked_overtime",
          "other",
          null,
        ],
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },

      recordedAt: {
        type: Date,
        default: null,
      },
    },

    // --- CHECKOUT FALLBACK ---
    // Used when professional forgets to check out or checkout cannot be completed.
    // Settlement can continue only after employer confirmation or admin review.

    checkoutFallback: {
      required: { type: Boolean, default: false },

      reason: {
        type: String,
        enum: [
          "professional_forgot",
          "system_timeout",
          "pin_issue",
          "employer_confirmed",
          "admin_override",
          "other",
          null,
        ],
        default: null,
      },

      requestedAt: {
        type: Date,
        default: null,
      },

      resolvedAt: {
        type: Date,
        default: null,
      },

      resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      approvedEndTime: {
        type: Date,
        default: null,
        // Used as effective checkout time if fallback is approved.
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },
    },

    // --- MISSED CHECK-IN REQUEST ---
    // Triggered when professional attempts check-out without a valid check-in.
    // Location captured at submission time only. It cannot prove earlier arrival.

    missedCheckInRequest: {
      claimedStartTime: { type: Date, default: null },
      submittedAt: { type: Date, default: null },

      locationAtSubmission: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracy: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
      },

      reviewedAt: { type: Date, default: null },

      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      outcome: {
        type: String,
        enum: ["approved", "rejected", null],
        default: null,
      },

      approvedStartTime: {
        type: Date,
        default: null,
        // Used instead of checkedInAt in settlement calculation when approved.
        // Service layer: effectiveStartTime = approvedStartTime ?? checkedInAt
      },

      rejectionReason: {
        type: String,
        trim: true,
        default: null,
      },
    },

    // --- PIN ISSUE REPORT ---
    // Triggered when professional is physically present but cannot obtain a PIN.
    // Location is captured as evidence of presence at the branch.

    pinIssueReport: {
      type: {
        type: String,
        enum: ["checkin", "checkout", null],
        default: null,
      },

      reason: {
        type: String,
        trim: true,
        default: null,
      },

      submittedAt: {
        type: Date,
        default: null,
      },

      locationAtSubmission: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracy: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
      },

      resolvedAt: {
        type: Date,
        default: null,
      },

      resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      outcome: {
        type: String,
        enum: ["pin_provided", "overridden", "rejected", null],
        default: null,
        // pin_provided means admin resent or shared the PIN.
        // overridden means admin manually marked attendance without PIN.
        // rejected means the report was invalid.
      },
    },

    // --- REQUIREMENTS & SCOPE ---

    requiredSkills: [
      {
        type: String,
        trim: true,
      },
    ],

    dressCode: {
      type: String,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // --- OVERTIME ---
    // Overtime is not automatically created just because checkout is late.
    // It must be intentionally requested by the professional.
    // Employer must approve, reject with reason, or raise a dispute.
    // If employer does nothing, service layer can restrict employer actions.

    overtime: {
      requested: {
        type: Boolean,
        default: false,
      },

      requestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      requestedAt: {
        type: Date,
        default: null,
      },

      source: {
        type: String,
        enum: ["late_checkout_prompt", "manual_request", null],
        default: null,
      },

      reason: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },

      extraHours: {
        type: Number,
        default: null,
        // Example: 0.50, 1.00, 1.25
      },

      status: {
        type: String,
        enum: ["pending", "approved", "rejected", "disputed", "cancelled", null],
        default: null,
      },

      employerResponseDeadlineAt: {
        type: Date,
        default: null,
      },

      employerRespondedAt: {
        type: Date,
        default: null,
      },

      employerResponseOverdueAt: {
        type: Date,
        default: null,
        // Set by cron/service when employer misses the response deadline.
      },

      restrictionTriggeredAt: {
        type: Date,
        default: null,
        // Set when employer account restrictions are triggered because overtime was ignored.
      },

      approvedAt: {
        type: Date,
        default: null,
      },

      approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      rejectedAt: {
        type: Date,
        default: null,
      },

      rejectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      rejectionReason: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },

      disputedAt: {
        type: Date,
        default: null,
      },

      disputedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      topUpAmount: {
        type: Number,
        default: null,
        // Extra employer payment required for approved overtime.
      },

      topUpPaid: {
        type: Boolean,
        default: false,
      },

      topUpPaidAt: {
        type: Date,
        default: null,
      },
    },

    // --- CANCELLATION ---

    cancelledBy: {
      type: String,
      enum: ["employer", "professional", "system", "admin", null],
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancellationFeeAmount: {
      type: Number,
      default: 0,
      // Optional future rule.
      // Used if employer cancels too late or professional cancels after confirmation.
    },

    cancellationFeeChargedTo: {
      type: String,
      enum: ["employer", "professional", null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

shiftSchema.index({ referenceCode: 1 }, { unique: true });

shiftSchema.index({ status: 1 });
shiftSchema.index({ attendanceStatus: 1 });
shiftSchema.index({ paymentStatus: 1, status: 1 });

shiftSchema.index({ business: 1 });
shiftSchema.index({ branch: 1 });
shiftSchema.index({ postedBy: 1 });

shiftSchema.index({ assignedProfessional: 1 });
shiftSchema.index({ professionalType: 1 });

shiftSchema.index({ startTime: 1 });
shiftSchema.index({ endTime: 1 });

shiftSchema.index({ assignedProfessional: 1, startTime: 1, endTime: 1 });

shiftSchema.index({ "lateCheckout.occurred": 1 });
shiftSchema.index({ "checkoutFallback.required": 1 });

shiftSchema.index({ "overtime.status": 1 });
shiftSchema.index({ "overtime.topUpPaid": 1 });
shiftSchema.index({ "overtime.employerResponseDeadlineAt": 1 });

shiftSchema.index({ fundingTransaction: 1 });
shiftSchema.index({ topUpTransaction: 1 });
shiftSchema.index({ refundTransaction: 1 });

module.exports = mongoose.model("Shift", shiftSchema);
