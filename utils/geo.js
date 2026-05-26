// utils/geo.js

function buildGeoPoint(
  latitude,
  longitude,
  errorMessage = "Please select a valid address from the suggestions."
) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  const hasValidCoordinates =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  if (!hasValidCoordinates) {
    throw new Error(errorMessage);
  }

  return {
    type: "Point",
    coordinates: [lng, lat], // MongoDB GeoJSON requires [longitude, latitude]
  };
}

module.exports = {
  buildGeoPoint,
};
