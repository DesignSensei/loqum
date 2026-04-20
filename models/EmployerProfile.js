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

    pharmacyName: {
      type: String,
      required: true,
      trim: true,
    },

    businessRegistrationNumber: {
      type: String,
      trim: true,
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
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
