// models/Branch.js

const mongoose = require("mongoose");

/**
 * GEOLOCATION:
 * Coordinates are stored in GeoJSON Point format required for MongoDB 2dsphere indexing.
 *
 * Note:
 * GeoJSON uses [longitude, latitude] order, not [latitude, longitude].
 *
 * Branch coordinates are used by the attendance service to validate whether
 * a professional is physically within the allowed geofence radius during
 * check-in and check-out.
 *
 * Example:
 * location.coordinates = [3.3792, 6.5244]
 * geofenceRadiusMeters = 100
 */

const branchSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    name: {
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
      trim: true,
      required: true,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
    },

    // --- GEOLOCATION ---
    // GeoJSON Point.
    // coordinates: [longitude, latitude]

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
    },

    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: undefined,
      },

      coordinates: {
        type: [Number],
        default: undefined,
        validate: {
          validator: function (value) {
            if (value == null) return true;
            if (!Array.isArray(value) || value.length !== 2) return false;

            const [lng, lat] = value;

            return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
          },
          message: "Coordinates must be [longitude, latitude] with valid ranges.",
        },
      },
    },

    geofenceRadiusMeters: {
      type: Number,
      default: 100,
      min: 20,
      max: 1000,
      // Default attendance radius is 100 meters.
      // Can be adjusted per branch if needed.
    },

    // --- CONTACT ---

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    contactPhone: {
      type: String,
      trim: true,
    },
    // --- STATUS ---

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

branchSchema.index({ business: 1 });
// All branches belonging to an employer.

branchSchema.index({ business: 1, isActive: 1 });
// Active branches for an employer, used when posting a shift.

branchSchema.index({ location: "2dsphere" }, { sparse: true });
// Geospatial queries.
// Sparse because branch coordinates may be added after branch creation.

branchSchema.index({ state: 1, lga: 1 });
// Location-based filtering.

module.exports = mongoose.model("Branch", branchSchema);
