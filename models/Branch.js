// models/Branch.js

const mongoose = require("mongoose");

const geoPointSchema = require("./helpers/geoPointSchema");

/**
 * GEOLOCATION:
 *
 * Coordinates are stored in GeoJSON Point format required for MongoDB
 * 2dsphere indexing.
 *
 * GeoJSON uses [longitude, latitude] order, not [latitude, longitude].
 *
 * Branch creation requires a Google Places address selection. The selected
 * place provides the formatted address, Google Place ID, longitude and
 * latitude.
 *
 * Branch coordinates are used for:
 *
 * - attendance geofence validation
 * - future distance-based shift filtering
 * - future "closest to you" shift sorting
 *
 * Example:
 *
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
      maxlength: 120,
    },

    address: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    state: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    // --- GEOLOCATION ---
    //
    // GeoJSON Point.
    // coordinates: [longitude, latitude]
    //
    // Branch creation requires a valid Google Places selection and resolved
    // coordinates. An operational branch cannot exist without geolocation.

    googlePlaceId: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    location: {
      type: geoPointSchema,
      required: true,
    },

    geofenceRadiusMeters: {
      type: Number,
      default: 100,
      min: 20,
      max: 1000,
      validate: {
        validator: Number.isSafeInteger,
        message: "geofenceRadiusMeters must be a whole number.",
      },

      // Default attendance radius is 100 meters.
      //
      // Branch creation should preferably resolve the current default from
      // PlatformSettingsService. This schema default remains a safety fallback.
    },

    // --- CONTACT ---

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "",
      maxlength: 10,
    },

    contactPhone: {
      type: String,
      trim: true,
      maxlength: 30,
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

branchSchema.index({
  business: 1,
  isActive: 1,
  name: 1,
});
// Active branches for an employer.
// Used for the employer post-shift branch dropdown.

branchSchema.index({
  location: "2dsphere",
});
// Geospatial attendance, distance sorting and nearby-location queries.

branchSchema.index({
  state: 1,
  lga: 1,
});
// Location-based filtering.

module.exports = mongoose.model("Branch", branchSchema);
