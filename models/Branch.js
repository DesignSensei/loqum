// models/Branch.js

const mongoose = require("mongoose");

/**
 * GEOLOCATION:
 *
 * Coordinates are stored in GeoJSON Point format required for MongoDB
 * 2dsphere indexing.
 *
 * GeoJSON uses [longitude, latitude] order, not [latitude, longitude].
 *
 * Branch coordinates are used by the attendance service to validate whether
 * a professional is physically within the allowed geofence radius during
 * check-in and check-out.
 *
 * Example:
 *
 * location.coordinates = [3.3792, 6.5244]
 * geofenceRadiusMeters = 100
 */

const locationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },

    coordinates: {
      type: [Number],
      required: true,
      validate: [
        {
          validator: (coordinates) => Array.isArray(coordinates) && coordinates.length === 2,
          message: "Branch coordinates must contain longitude and latitude.",
        },
        {
          validator: (coordinates) => {
            if (!Array.isArray(coordinates) || coordinates.length !== 2) {
              return false;
            }

            const [longitude, latitude] = coordinates;

            return (
              Number.isFinite(longitude) &&
              Number.isFinite(latitude) &&
              longitude >= -180 &&
              longitude <= 180 &&
              latitude >= -90 &&
              latitude <= 90
            );
          },
          message: "Coordinates must be [longitude, latitude] with valid ranges.",
        },
      ],
    },
  },
  {
    _id: false,
  }
);

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
    // The entire location field remains undefined when the branch has not
    // yet been geocoded.

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 250,
    },

    location: {
      type: locationSchema,
      default: undefined,
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
      default: "+234",
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

branchSchema.index({ business: 1 });
// All branches belonging to an employer.

branchSchema.index({
  business: 1,
  isActive: 1,
  name: 1,
});
// Active branches for an employer.
// Used for the employer post-shift branch dropdown.

branchSchema.index({ location: "2dsphere" }, { sparse: true });
// Geospatial attendance and nearby-location queries.
// Sparse because coordinates may be added after branch creation.

branchSchema.index({ state: 1, lga: 1 });
// Location-based filtering.

module.exports = mongoose.model("Branch", branchSchema);
