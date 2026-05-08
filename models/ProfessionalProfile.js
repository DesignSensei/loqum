// models/ProfessionalProfile.js

const mongoose = require("mongoose");

const professionalProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    type: {
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

    phone: {
      type: String,
      trim: true,
    },

    phoneCode: {
      type: String,
      trim: true,
    },

    specialty: {
      type: String,
      trim: true,
      required: true,
    },

    address: {
      type: String,
      trim: true,
    },

    state: {
      type: String,
      required: true,
    },

    lga: {
      type: String,
      required: true,
    },

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    licenceNumber: {
      type: String,
      trim: true,
      required: true,
    },

    licenceVerified: {
      type: Boolean,
      default: false,
    },

    yearsOfExperience: {
      type: Number,
      min: 0,
    },

    certifications: [
      {
        name: { type: String, trim: true, required: true },
        issuingBody: { type: String, trim: true }, // e.g. "American Heart Association"
        dateObtained: { type: Date },
        expiryDate: { type: Date }, // null if it doesn't expire
        documentUrl: { type: String, trim: true }, // uploaded certificate file
        verified: { type: Boolean, default: false }, // verified by Loqum admin
      },
    ],

    availableDates: [
      {
        type: Date,
      },
    ],

    // --- FINANCIAL ---

    nuban: {
      accountNumber: { type: String, trim: true },
      bankName: { type: String, trim: true },
      paystackRecipientCode: { type: String, trim: true }, // for transfers
      isActive: { type: Boolean, default: false },
    },

    bvn: {
      type: String,
      trim: true,
      select: false, // never returned in queries unless explicitly requested
    },

    walletBalance: {
      type: Number,
      default: 0, // for manual top-ups
    },

    outstandingBalance: {
      type: Number,
      default: 0, // commission owed from off-platform shifts
    },

    totalEarnings: {
      type: Number,
      default: 0, // cumulative on-platform earnings
    },

    // --- ACCOUNT STATUS ---

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
    },

    // --- STRIKES ---

    strikes: {
      noShows: { type: Number, default: 0 },
      lateArrivals: { type: Number, default: 0 },
      earlyDepartures: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    // --- SHIFT ACTIVITY ---

    totalShiftsCompleted: {
      type: Number,
      default: 0,
    },

    totalHoursWorked: {
      type: Number,
      default: 0,
    },

    // --- REPUTATION ---

    reviews: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Review",
      },
    ],

    averageRating: {
      type: Number,
      default: 0,
    },

    totalReviews: {
      type: Number,
      default: 0,
    },

    reliabilityScore: {
      type: Number,
      default: 100, // starts at 100, decremented by strikes
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProfessionalProfile", professionalProfileSchema);
