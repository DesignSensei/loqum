// models/helpers/geoPointSchema.js

const mongoose = require("mongoose");

const geoPointSchema = new mongoose.Schema(
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
          message: "Coordinates must contain longitude and latitude.",
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

module.exports = geoPointSchema;
