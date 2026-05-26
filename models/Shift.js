// models/Shift.js

const mongoose = require("mongoose");

/**
 * PAYMENT ARCHITECTURE:
 * All shifts use escrow universally. No direct bank charges per shift.
 * Flow: Employer Wallet → Escrow Wallet (on confirmation) → Professional Wallet (on settlement)
 * Paystack is only involved at wallet funding (DVA) and professional withdrawal.
 *
 * ATTENDANCE:
 * Both PINs are generated at shift creation.
 * Check-in PIN: visible to employer from shortly before start time.
 * Check-out PIN: revealed to employer only after successful check-in.
 * No check-in → no check-out. No check-out → no settlement.
 */

const shiftSchema = new mongoose.Schema(
  {
    // --- CORE IDENTITY ---

    referenceCode: {
      type: String,
      unique: true,
      // e.g. LQM-8821 — generated on creation
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
      required: true, // owner or branch manager who posted
    },

    department: {
      type: String,
      trim: true, // e.g. "Emergency Ward", "General Practice"
    },

    roleTitle: {
      type: String,
      trim: true,
      required: true, // e.g. "Locum Pharmacist", "Staff Nurse"
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

    breakDuration: {
      type: Number,
      default: 0,
      // In minutes. Informational only — tells the professional
      // what break they can expect during the shift.
      // Not used in settlement calculation.
    },

    billableHours: {
      type: Number,
      // checkedOutAt - effectiveStartTime in hours
      // effectiveStartTime = checkedInAt or missedCheckInRequest.approvedStartTime
    },

    // --- FINANCIALS ---

    hourlyRate: {
      type: Number,
      required: true, // in Naira e.g. 5000
    },

    totalPayout: {
      type: Number,
      // hourlyRate * billableHours — gross amount before commission
      // calculated at settlement
    },

    commissionRate: {
      type: Number,
      default: null,
      // Snapshotted at assignment time from professional's tier.
      // Immutable after that — protects professional from mid-shift rate changes.
      // newcomer → 0.075, accredited → 0.0625, elite → 0.05 (example)
    },

    commissionAmount: {
      type: Number,
      default: null, // calculated at settlement: totalPayout * commissionRate
    },

    professionalEarnings: {
      type: Number,
      // totalPayout - commissionAmount — net amount credited to professional wallet
      // calculated at settlement
    },

    // --- PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: [
        "unpaid", // escrow not yet funded — shift not confirmed
        "escrowed", // funds held in escrow wallet — shift confirmed
        "released", // professional wallet credited — settlement complete
        "failed", // settlement or escrow step failed — cron will retry
        "refunded", // shift cancelled — escrow returned to employer wallet
      ],
      default: "unpaid",
    },

    // --- PROFESSIONAL ASSIGNMENT ---

    assignedProfessional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
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
        "open", // visible, accepting applications
        "assigned", // professional selected, awaiting escrow funding
        "confirmed", // escrow funded, shift locked in
        "in_progress", // professional checked in
        "pending_settlement", // professional checked out, settlement calculating
        "completed", // settlement done, professional wallet credited
        "cancelled", // cancelled before shift started
        "disputed", // conflict raised, escrow held pending review
        "no_show", // professional did not check in within grace window
      ],
      default: "open",
    },

    // --- PINS ---

    checkInPin: {
      type: String,
      default: null,
      // Generated at shift creation.
      // Visible to employer from shortly before start time only.
      // Never exposed to the professional.
    },

    checkOutPin: {
      type: String,
      default: null,
      // Generated at shift creation.
      // Revealed to employer only after successful check-in.
      // Professional enters it on departure.
    },

    // --- ATTENDANCE ---

    attendanceStatus: {
      type: String,
      enum: [
        "not_started",
        "checked_in",
        "checked_out",
        "missed_checkin_review",
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
    },

    checkOutLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      capturedAt: { type: Date, default: null },
    },

    // --- MISSED CHECK-IN REQUEST ---
    // Triggered when professional attempts check-out without a valid check-in.
    // Location captured at submission time only — cannot prove earlier arrival.

    missedCheckInRequest: {
      claimedStartTime: { type: Date, default: null },
      submittedAt: { type: Date, default: null },

      locationAtSubmission: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracy: { type: Number, default: null }, // metres — from browser Geolocation API
        capturedAt: { type: Date, default: null }, // moment of browser permission grant
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
      rejectionReason: { type: String, trim: true, default: null },
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
      reason: { type: String, trim: true, default: null },
      submittedAt: { type: Date, default: null },

      locationAtSubmission: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracy: { type: Number, default: null }, // metres
        capturedAt: { type: Date, default: null },
      },

      resolvedAt: { type: Date, default: null },
      resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      outcome: {
        type: String,
        enum: ["pin_provided", "overridden", "rejected", null],
        default: null,
        // pin_provided → admin resent or shared the PIN
        // overridden   → admin manually marked attendance without PIN
        // rejected     → report deemed invalid
      },
    },

    // --- REQUIREMENTS & SCOPE ---

    requiredSkills: [
      {
        type: String,
        trim: true, // e.g. "Electronic Medical Records", "Basic Life Support"
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

    // --- CANCELLATION ---

    cancelledBy: {
      type: String,
      enum: ["employer", "professional", "system", null],
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

shiftSchema.index({ status: 1 });
shiftSchema.index({ attendanceStatus: 1 });
// cron: find checked_out shifts pending settlement
// cron: find in_progress shifts past endTime with no check-out (no_show candidates)

shiftSchema.index({ business: 1 });
shiftSchema.index({ branch: 1 });
shiftSchema.index({ assignedProfessional: 1 });
shiftSchema.index({ professionalType: 1 });
shiftSchema.index({ startTime: 1 });
shiftSchema.index({ paymentStatus: 1, status: 1 });
// cron: find escrowed shifts that failed settlement and need retry
shiftSchema.index({ assignedProfessional: 1, startTime: 1, endTime: 1 });

module.exports = mongoose.model("Shift", shiftSchema);
