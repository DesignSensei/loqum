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

    yearsOfExperience: {
      type: Number,
      min: 0,
    },

    certifications: [
      {
        type: String,
        trim: true,
      },
    ],

    availableDates: [
      {
        type: Date,
      },
    ],

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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProfessionalProfile", professionalProfileSchema);
