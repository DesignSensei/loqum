// models/Branch.js

const mongoose = require("mongoose");

/**
 * GEOLOCATION:
 * Coordinates are stored in GeoJSON Point format required for MongoDB 2dsphere indexing.
 * Note: GeoJSON uses [longitude, latitude] order, not [latitude, longitude].
 *
 * Branch coordinates are used by the service layer when reviewing PIN issue reports —
 * comparing the professional's submitted location against the branch position
 * to assess whether they were physically present.
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
      required: true,
    },

    lga: {
      type: String,
      required: true,
    },

    // --- GEOLOCATION ---
    // GeoJSON Point — required for 2dsphere index.
    // coordinates: [longitude, latitude] — note the order.

    coordinates: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
    },

    // --- CONTACT ---

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
// All branches belonging to an employer

branchSchema.index({ business: 1, isActive: 1 });
// Active branches for an employer — used when posting a shift

branchSchema.index({ coordinates: "2dsphere" }, { sparse: true });
// Geospatial queries — find branches near a location.
// Sparse because coordinates are optional at creation.

branchSchema.index({ state: 1, lga: 1 });
// Location-based filtering

module.exports = mongoose.model("Branch", branchSchema);
