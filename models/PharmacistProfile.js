// models/PharmacistProfile.js

const mongoose = require("mongoose");

const pharmacistProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
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
      enum: [
        "Community",
        "Hospital",
        "Industrial",
        "Academic",
        "Administrative",
      ],
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
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("PharmacistProfile", pharmacistProfileSchema);
