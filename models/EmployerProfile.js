// models/EmployerProfile.js

const mongoose = require("mongoose");

const employerProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    type: {
      type: String,
      enum: ["pharmacy", "clinic", "hospital", "laboratory"],
      required: true,
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessRegistrationNumber: {
      type: String,
      trim: true,
    },

    cacVerified: {
      type: Boolean,
      default: false,
    },

    businessPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    businessPhone: {
      type: String,
      trim: true,
    },

    address: {
      type: String,
      trim: true,
    },

    coordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },

    state: {
      type: String,
      required: true,
    },

    lga: {
      type: String,
      required: true,
    },

    contactFirstName: {
      type: String,
      trim: true,
    },

    contactLastName: {
      type: String,
      trim: true,
    },

    contactPhone: {
      type: String,
      trim: true,
    },

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    // --- FINANCIAL ---

    outstandingInvoices: {
      type: Number,
      default: 0,
    },

    totalShiftsPaid: {
      type: Number,
      default: 0,
    },

    totalAmountSpent: {
      type: Number,
      default: 0,
    },

    // --- ACCOUNT STATUS ---

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
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

    totalShiftsPosted: {
      type: Number,
      default: 0,
    },

    totalShiftsCompleted: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
