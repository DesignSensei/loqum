// services/helpers/branchValidationHelpers.js

exports.hasValidBranchLocation = function hasValidBranchLocation(branch) {
  const coordinates = branch?.location?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return false;
  }

  const [longitude, latitude] = coordinates;

  return (
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
};
