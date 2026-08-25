// models/helpers/attendanceLocationSchema.js

const mongoose = require("mongoose");

const attendanceLocationSchema = new mongoose.Schema(
  {
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
    },

    capturedAt: {
      type: Date,
      default: null,
    },

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
    },

    distanceFromBranchMeters: {
      type: Number,
      default: null,
      min: 0,
    },

    withinGeofence: {
      type: Boolean,
      default: null,
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
  {
    _id: false,
  }
);

module.exports = attendanceLocationSchema;
