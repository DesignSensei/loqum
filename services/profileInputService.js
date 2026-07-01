// services/profileInputService.js

const { buildGeoPoint } = require("../utils/geo");

/* ─────────────────────────────── SHARED HELPERS ─────────────────────────────── */

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/* ─────────────────────────────── PROFESSIONAL PROFILE INPUT ─────────────────────────────── */

function validateProfessionalLicenceNumber(type, licenceNumber) {
  if (type === "pharmacist" && !/^[0-9]{6}$/.test(String(licenceNumber || "").trim())) {
    throw new Error("PCN licence number must be exactly 6 digits.");
  }
}

function buildProfessionalProfileData(data = {}) {
  const {
    type,
    licenceNumber,
    phoneCode,
    phone,
    specialty,
    address,
    state,
    lga,
    latitude,
    longitude,
    googlePlaceId,
    yearsOfExperience,
    bio,
  } = data;

  if (!type || !licenceNumber || !phone || !phoneCode || !specialty || !address || !state || !lga) {
    throw new Error("Missing required professional or location fields");
  }

  validateProfessionalLicenceNumber(type, licenceNumber);

  if (!String(googlePlaceId || "").trim()) {
    throw new Error("Please select a valid address from the suggestions.");
  }

  const location = buildGeoPoint(
    latitude,
    longitude,
    "Please select a valid address from the suggestions."
  );

  return {
    type: String(type).trim(),
    licenceNumber: String(licenceNumber).trim(),
    phoneCode: String(phoneCode).trim(),
    phone: String(phone).trim(),
    specialty: String(specialty).trim(),
    address: String(address).trim(),
    googlePlaceId: String(googlePlaceId).trim(),
    location,
    state: String(state).trim(),
    lga: String(lga).trim(),
    yearsOfExperience: Number(yearsOfExperience) || 0,
    bio: String(bio || "").trim(),
  };
}

/* ─────────────────────────────── EMPLOYER PROFILE INPUT ─────────────────────────────── */

const regulatoryBodyLabels = {
  pcn: "Pharmacists Council of Nigeria",
  hefamaa: "Health Facilities Monitoring and Accreditation Agency",
  state_moh: "State Ministry of Health",
  mlscn: "Medical Laboratory Science Council of Nigeria",
  other: "Other Regulatory Body",
};

function getRegulatoryBody(type, state) {
  const cleanType = String(type || "").trim();
  const cleanState = String(state || "")
    .trim()
    .toLowerCase();

  if (cleanType === "pharmacy") {
    return "pcn";
  }

  if (cleanType === "laboratory") {
    return "mlscn";
  }

  if (cleanType === "clinic" || cleanType === "hospital") {
    return cleanState === "lagos" ? "hefamaa" : "state_moh";
  }

  return null;
}

function getRegulatoryBodyLabel(regulatoryBody) {
  return regulatoryBodyLabels[regulatoryBody] || "-";
}

function normalizeCACRegistrationNumber(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeRegulatoryRegistrationNumber(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isValidCACRegistrationNumber(value) {
  return /^(RC|BN|IT|LP|LLP)\d{4,10}$/i.test(value);
}

function isValidRegulatoryRegistrationNumber(value) {
  return /^[A-Z0-9/\\\- ]{4,30}$/i.test(value);
}

function buildEmployerProfileData(data = {}) {
  const {
    type,
    businessName,
    businessEmail,
    cacRegistrationNumber,
    regulatoryRegistrationNumber,
    state,
    lga,
    address,
    latitude,
    longitude,
    googlePlaceId,
    businessPhoneCode,
    businessPhone,
    contactFirstName,
    contactLastName,
    contactRole,
    contactPhoneCode,
    contactPhone,
  } = data;

  const cleanType = String(type || "").trim();
  const cleanState = String(state || "").trim();

  if (
    !cleanType ||
    !businessName ||
    !businessEmail ||
    !cacRegistrationNumber ||
    !regulatoryRegistrationNumber ||
    !cleanState ||
    !lga ||
    !address ||
    !businessPhoneCode ||
    !businessPhone ||
    !contactFirstName ||
    !contactLastName ||
    !contactRole ||
    !contactPhoneCode ||
    !contactPhone
  ) {
    throw new Error("Missing required employer profile fields.");
  }

  const regulatoryBody = getRegulatoryBody(cleanType, cleanState);

  if (!regulatoryBody) {
    throw new Error("Invalid employer type selected.");
  }

  if (!String(googlePlaceId || "").trim()) {
    throw new Error("Please select a valid business address from the suggestions.");
  }

  const location = buildGeoPoint(
    latitude,
    longitude,
    "Please select a valid business address from the suggestions."
  );

  const normalizedBusinessEmail = normalizeEmail(businessEmail);

  if (!isValidEmail(normalizedBusinessEmail)) {
    throw new Error("Enter a valid business email address.");
  }

  const normalizedCACRegistrationNumber = normalizeCACRegistrationNumber(cacRegistrationNumber);

  if (!isValidCACRegistrationNumber(normalizedCACRegistrationNumber)) {
    throw new Error("Enter a valid CAC number, e.g. RC1234567 or BN1234567.");
  }

  const normalizedRegulatoryRegistrationNumber = normalizeRegulatoryRegistrationNumber(
    regulatoryRegistrationNumber
  );

  if (!isValidRegulatoryRegistrationNumber(normalizedRegulatoryRegistrationNumber)) {
    throw new Error(
      "Enter a valid regulatory registration number exactly as shown on the certificate."
    );
  }

  return {
    type: cleanType,

    businessName: String(businessName).trim(),
    businessEmail: normalizedBusinessEmail,

    cacRegistrationNumber: normalizedCACRegistrationNumber,

    regulatoryBody,
    regulatoryRegistrationNumber: normalizedRegulatoryRegistrationNumber,

    businessPhoneCode: String(businessPhoneCode).trim(),
    businessPhone: String(businessPhone).trim(),

    address: String(address).trim(),
    googlePlaceId: String(googlePlaceId).trim(),
    location,
    state: cleanState,
    lga: String(lga).trim(),

    contactFirstName: String(contactFirstName).trim(),
    contactLastName: String(contactLastName).trim(),
    contactRole: String(contactRole).trim(),
    contactPhoneCode: String(contactPhoneCode).trim(),
    contactPhone: String(contactPhone).trim(),
  };
}

class ProfileInputService {
  static buildProfessionalProfileData(data) {
    return buildProfessionalProfileData(data);
  }

  static buildEmployerProfileData(data) {
    return buildEmployerProfileData(data);
  }

  static getRegulatoryBody(type, state) {
    return getRegulatoryBody(type, state);
  }

  static getRegulatoryBodyLabel(regulatoryBody) {
    return getRegulatoryBodyLabel(regulatoryBody);
  }

  static getRegulatoryBodyLabels() {
    return { ...regulatoryBodyLabels };
  }
}

module.exports = ProfileInputService;
