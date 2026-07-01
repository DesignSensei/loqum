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
 * Professional check-in and check-out are validated using geofencing.
 *
 * The professional's device submits latitude, longitude, accuracy, and timestamp.
 * The service layer compares that location with the assigned branch location.
 *
 * Branch.location is the source of truth for the pharmacy/branch position.
 * Branch.geofenceRadiusMeters defines the allowed attendance radius.
 * Default expected radius is 100 meters.
 *
 * The result is snapshotted on this shift so historical attendance records remain
 * accurate even if the branch location or radius changes later.
 *
 * No valid geofence check-in means no automatic settlement.
 * No valid check-out means settlement requires employer confirmation or admin fallback.
 * Late check-out does not automatically mean paid overtime.
 * If the professional checks out after endTime, the UI should ask whether they
 * are only checking out late or requesting overtime.
 */

const attendanceLocationSchema = new mongoose.Schema(
  {
    // Professional/device location captured from the browser or mobile app
    latitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90,
    },

    longitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180,
    },

    accuracyMeters: {
      type: Number,
      default: null,
      min: 0,
      // GPS accuracy reported by the device/browser.
      // Example: 15 means the location may be accurate within about 15 meters.
    },

    capturedAt: {
      type: Date,
      default: null,
    },

    // Branch location snapshot at the time attendance was attempted
    branchLatitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90,
    },

    branchLongitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180,
    },

    geofenceRadiusMeters: {
      type: Number,
      default: null,
      min: 1,
      // Snapshotted from Branch.geofenceRadiusMeters.
    },

    distanceFromBranchMeters: {
      type: Number,
      default: null,
      min: 0,
      // Calculated by the service layer.
    },

    withinGeofence: {
      type: Boolean,
      default: null,
      // true means the professional was within the allowed branch radius.
    },

    locationSource: {
      type: String,
      enum: ["browser", "mobile_app", "admin_override", "employer_confirmation", null],
      default: null,
    },

    failureReason: {
      type: String,
      enum: [
        "outside_geofence",
        "location_permission_denied",
        "gps_accuracy_too_low",
        "branch_location_missing",
        "professional_location_missing",
        "system_error",
        null,
      ],
      default: null,
    },
  },
  { _id: false }
);

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
    },

    pricingLockedAt: {
      type: Date,
      default: null,
    },

    pricingLockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    estimatedProfessionalPay: {
      type: Number,
      default: null,
    },

    estimatedPlatformFee: {
      type: Number,
      default: null,
    },

    estimatedEmployerCharge: {
      type: Number,
      default: null,
    },

    fundedAmount: {
      type: Number,
      default: 0,
    },

    baseProfessionalPay: {
      type: Number,
      default: null,
    },

    basePlatformFee: {
      type: Number,
      default: null,
    },

    baseEmployerCharge: {
      type: Number,
      default: null,
    },

    overtimeProfessionalPay: {
      type: Number,
      default: null,
    },

    overtimePlatformFee: {
      type: Number,
      default: null,
    },

    overtimeEmployerCharge: {
      type: Number,
      default: null,
    },

    finalProfessionalPay: {
      type: Number,
      default: null,
    },

    finalPlatformFee: {
      type: Number,
      default: null,
    },

    finalEmployerCharge: {
      type: Number,
      default: null,
    },

    topUpRequired: {
      type: Number,
      default: 0,
    },

    refundedAmount: {
      type: Number,
      default: 0,
    },

    // --- PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: [
        "unpaid",
        "funded",
        "base_release_pending",
        "base_released",
        "awaiting_overtime_review",
        "awaiting_topup",
        "released",
        "failed",
        "refunded",
        "partially_refunded",
      ],
      default: "unpaid",
    },

    // --- TRANSACTION REFERENCES ---

    fundingTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    topUpTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    refundTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    payoutTransactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
      },
    ],

    platformFeeTransactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
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
        // Professional has checked in through valid geofence attendance.

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

    // --- ATTENDANCE ---

    attendanceStatus: {
      type: String,
      enum: [
        "not_started",
        // No valid check-in yet.

        "checked_in",
        // Professional successfully checked in within the geofence.

        "checked_out",
        // Professional successfully checked out within the geofence.

        "missed_checkin_review",
        // Professional claims they worked but did not complete valid check-in.

        "checkout_fallback_review",
        // Professional could not complete valid checkout.

        "disputed",
        // Attendance is under dispute.

        "settled",
        // Attendance has been accepted for settlement.
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
      type: attendanceLocationSchema,
      default: () => ({}),
    },

    checkOutLocation: {
      type: attendanceLocationSchema,
      default: () => ({}),
    },

    // --- ATTENDANCE REVIEW / OVERRIDE ---
    // Used when geofence attendance fails but employer/admin confirms presence.

    attendanceOverride: {
      used: {
        type: Boolean,
        default: false,
      },

      type: {
        type: String,
        enum: ["checkin", "checkout", "both", null],
        default: null,
      },

      reason: {
        type: String,
        enum: [
          "branch_location_incorrect",
          "gps_accuracy_issue",
          "location_permission_issue",
          "network_issue",
          "employer_confirmed_presence",
          "admin_confirmed_presence",
          "system_error",
          "other",
          null,
        ],
        default: null,
      },

      approvedStartTime: {
        type: Date,
        default: null,
        // Used as effective start time if check-in override is approved.
      },

      approvedEndTime: {
        type: Date,
        default: null,
        // Used as effective end time if check-out override is approved.
      },

      reviewedAt: {
        type: Date,
        default: null,
      },

      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },
    },

    // --- LATE CHECKOUT ---
    // A late checkout is not the same as overtime.
    // Late checkout simply means checkedOutAt is after endTime.
    // The professional must intentionally request overtime if they want extra pay.

    lateCheckout: {
      occurred: {
        type: Boolean,
        default: false,
      },

      minutesLate: {
        type: Number,
        default: 0,
      },

      selectedOption: {
        type: String,
        enum: ["normal_late_checkout", "overtime_requested", null],
        default: null,
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
      required: {
        type: Boolean,
        default: false,
      },

      reason: {
        type: String,
        enum: [
          "professional_forgot",
          "system_timeout",
          "outside_geofence",
          "gps_accuracy_too_low",
          "location_permission_denied",
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
    // Triggered when professional claims they arrived/worked but did not complete
    // a valid geofence check-in.
    //
    // Location captured at submission time only.
    // It cannot prove earlier arrival by itself.

    missedCheckInRequest: {
      claimedStartTime: {
        type: Date,
        default: null,
      },

      submittedAt: {
        type: Date,
        default: null,
      },

      reason: {
        type: String,
        enum: [
          "forgot_to_checkin",
          "outside_geofence",
          "gps_accuracy_too_low",
          "location_permission_denied",
          "branch_location_incorrect",
          "network_issue",
          "system_error",
          "other",
          null,
        ],
        default: null,
      },

      locationAtSubmission: {
        type: attendanceLocationSchema,
        default: () => ({}),
      },

      reviewedAt: {
        type: Date,
        default: null,
      },

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
        maxlength: 300,
        default: null,
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
      },

      restrictionTriggeredAt: {
        type: Date,
        default: null,
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

shiftSchema.index({ "checkInLocation.withinGeofence": 1 });
shiftSchema.index({ "checkOutLocation.withinGeofence": 1 });

shiftSchema.index({ "lateCheckout.occurred": 1 });
shiftSchema.index({ "checkoutFallback.required": 1 });

shiftSchema.index({ "missedCheckInRequest.outcome": 1 });
shiftSchema.index({ "attendanceOverride.used": 1 });

shiftSchema.index({ "overtime.status": 1 });
shiftSchema.index({ "overtime.topUpPaid": 1 });
shiftSchema.index({ "overtime.employerResponseDeadlineAt": 1 });

shiftSchema.index({ fundingTransaction: 1 });
shiftSchema.index({ topUpTransaction: 1 });
shiftSchema.index({ refundTransaction: 1 });

module.exports = mongoose.model("Shift", shiftSchema);
