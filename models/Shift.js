// models/Shift.js

const mongoose = require("mongoose");

const shiftSchema = new mongoose.Schema(
  {
    // --- CORE IDENTITY ---

    referenceCode: {
      type: String,
      unique: true,
      // e.g. LQ-8821 — generated on creation
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
      ref: "User", // owner or branch manager who posted
      required: true,
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
      default: 0, // in minutes — e.g. 30, 60
    },

    billableHours: {
      type: Number, // calculated: (endTime - startTime - breakDuration) in hours
    },

    // --- FINANCIALS ---

    hourlyRate: {
      type: Number,
      required: true, // in Naira e.g. 5000
    },

    totalPayout: {
      type: Number, // hourlyRate * billableHours — what professional takes home before commission
    },

    professionalEarnings: {
      type: Number, // totalPayout after 5% commission deducted
    },

    paymentTimeline: {
      type: String,
      enum: ["instant", "next_day", "end_of_week"],
      default: "instant",
    },

    // --- PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: [
        "unpaid", // pharmacy hasn't paid yet
        "held", // payment received, sitting in Paystack
        "swept", // payout sent to professional's NUBAN
        "failed", // sweep failed — cron will retry
        "refunded", // shift cancelled or no-show, pharmacy refunded
      ],
      default: "unpaid",
    },

    paystackReference: {
      type: String,
      trim: true, // Paystack payment reference for this shift
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
      trim: true, // e.g. "Blue scrubs", "Business formal"
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // --- APPLICATIONS ---

    totalApplications: {
      type: Number,
      default: 0, // incremented each time a ShiftApplication is created
    },

    assignedProfessional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    // --- SHIFT STATUS ---

    status: {
      type: String,
      enum: [
        "open", // visible, accepting applications
        "assigned", // professional selected, awaiting payment
        "paid", // pharmacy has paid, shift confirmed
        "in_progress", // professional checked in
        "completed", // both parties confirmed
        "cancelled", // cancelled before shift started
        "disputed", // conflict raised, under review
        "no_show", // professional did not check in
      ],
      default: "open",
    },

    // --- CONFIRMATION ---

    employerConfirmed: {
      type: Boolean,
      default: false,
    },

    professionalConfirmed: {
      type: Boolean,
      default: false,
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
shiftSchema.index({ branch: 1 });
shiftSchema.index({ business: 1 });
shiftSchema.index({ professionalType: 1 });
shiftSchema.index({ startTime: 1 });
shiftSchema.index({ "branch.coordinates": "2dsphere" }); // for geolocation queries

module.exports = mongoose.model("Shift", shiftSchema);
