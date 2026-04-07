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

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    licenseNumber: {
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
