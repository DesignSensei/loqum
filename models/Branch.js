// models/Branch.js

const mongoose = require("mongoose");

const geoPointSchema = require("./helpers/geoPointSchema");

/**
 * BRANCH
 *
 * Represents one physical operating location belonging to
 * an EmployerProfile.
 *
 * The employer's onboarding address creates the initial Branch
 * with isPrimary set to true.
 *
 * Additional branches are created through the existing
 * employer branch-management workflow.
 *
 * Facility operating permits belong to individual branches
 * and are stored separately in FacilityPermit.
 *
 * A branch may exist without a verified permit, but it must
 * not participate in regulated marketplace activities until
 * all applicable facility requirements have been satisfied.
 *
 * Branch activation and facility regulatory verification are
 * independent. isActive does not mean regulatory approval.
 *
 * GEOLOCATION
 *
 * Coordinates use GeoJSON Point format:
 * [longitude, latitude].
 *
 * A Google Places selection provides the formatted address,
 * Google Place ID and coordinates.
 *
 * Branch coordinates support:
 * - Attendance geofence validation
 * - Distance-based shift filtering
 * - Nearby shift sorting
 *
 * Example:
 * location.coordinates = [3.3792, 6.5244]
 * geofenceRadiusMeters = 100
 */

const branchSchema = new mongoose.Schema(
  {
    // ───────────────────── BUSINESS OWNERSHIP ─────────────────────

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    /**
     * Identifies the branch created from the onboarding address.
     *
     * Onboarding explicitly sets isPrimary to true.
     * Additional branches default to false.
     *
     * Only one primary branch is permitted per business.
     */
    isPrimary: {
      type: Boolean,
      default: false,
      required: true,
      immutable: true,
    },

    // ───────────────────── BRANCH IDENTITY ─────────────────────

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

    // ───────────────────── GEOLOCATION ─────────────────────

    /**
     * Branch creation requires a valid Google Places selection.
     *
     * The selected location is also used when determining whether
     * an approved facility permit still covers this premises.
     *
     * FacilityPermit will preserve the reviewed location evidence.
     * Marketplace eligibility must compare that evidence with the
     * current branch location to prevent approval from carrying
     * over automatically to a different premises.
     */

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

      // Branch creation should preferably resolve the current default
      // from PlatformSettingsService. The schema default is a fallback.
    },

    // ───────────────────── CONTACT ─────────────────────

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

    // ───────────────────── BRANCH STATUS ─────────────────────

    /**
     * Operational branch status.
     *
     * This is not a regulatory approval status.
     * A branch must be active AND have the applicable
     * current verified permits before marketplace use.
     */

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// ───────────────────── INDEXES ─────────────────────

/**
 * Employer branch listing and active branch selection.
 */
branchSchema.index({
  business: 1,
  isActive: 1,
  name: 1,
});

/**
 * Enforce at most one primary branch per business.
 *
 * The partial index excludes non-primary branches,
 * allowing a business to operate multiple locations.
 *
 * The onboarding service must create the initial primary
 * branch in the employer onboarding transaction.
 */
branchSchema.index(
  {
    business: 1,
    isPrimary: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isPrimary: true,
    },
    name: "unique_primary_branch_per_business",
  }
);

/**
 * Geospatial attendance, distance sorting
 * and nearby-location queries.
 */
branchSchema.index({
  location: "2dsphere",
});

/**
 * Location-based filtering.
 */
branchSchema.index({
  state: 1,
  lga: 1,
});

// ───────────────────── IDENTITY UPDATE PROTECTION ─────────────────────

/**
 * Prevent ordinary query updates from transferring a branch
 * to another employer or changing its primary designation.
 *
 * Location and contact edits remain supported by BranchService.
 * Location changes must be considered by FacilityPermit readiness.
 */

function assertSafeBranchIdentityUpdate(update, options = {}, operation) {
  if (
    Array.isArray(update) ||
    options.overwrite ||
    ["replaceOne", "findOneAndReplace"].includes(operation)
  ) {
    throw new Error(
      "Branch replacements and update pipelines are unsupported; use document save()."
    );
  }

  const isProtectedPath = (path) => ["business", "isPrimary"].includes(String(path).split(".")[0]);

  for (const [operator, values] of Object.entries(update || {})) {
    if (!operator.startsWith("$")) {
      if (isProtectedPath(operator)) {
        throw new Error(
          "Branch ownership and primary designation cannot be changed through query updates."
        );
      }

      continue;
    }

    if (!values || typeof values !== "object") {
      continue;
    }

    for (const [path, value] of Object.entries(values)) {
      if (isProtectedPath(path) || (operator === "$rename" && isProtectedPath(value))) {
        throw new Error(
          "Branch ownership and primary designation cannot be changed through query updates."
        );
      }
    }
  }
}

branchSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  function () {
    assertSafeBranchIdentityUpdate(this.getUpdate(), this.getOptions(), this.op);
  }
);

branchSchema.pre("bulkWrite", function (operations) {
  for (const operation of operations) {
    if (operation.replaceOne) {
      throw new Error("Bulk branch replacement is unsupported; use document save().");
    }

    for (const name of ["updateOne", "updateMany"]) {
      if (operation[name]) {
        assertSafeBranchIdentityUpdate(operation[name].update, operation[name], name);
      }
    }
  }
});

module.exports = mongoose.model("Branch", branchSchema);
