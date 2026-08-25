// services/profileInputService.js

const { buildGeoPoint } = require("../utils/geo");

const regulatoryBodyLabels = {
  pcn: "Pharmacists Council of Nigeria",
  hefamaa: "Health Facilities Monitoring and Accreditation Agency",
  state_moh: "State Ministry of Health",
  mlscn: "Medical Laboratory Science Council of Nigeria",
  other: "Other Regulatory Body",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLowercase(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLowercase(value);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function assertRequiredFields(values, message) {
  const hasMissingField = values.some((value) => {
    return !normalizeText(value);
  });

  if (hasMissingField) {
    throw new Error(message);
  }
}

function validateProfessionalLicenceNumber(type, licenceNumber) {
  if (type === "pharmacist" && !/^\d{6}$/.test(licenceNumber)) {
    throw new Error("PCN licence number must be exactly 6 digits.");
  }
}

function getRegulatoryBody(type, state) {
  const cleanType = normalizeLowercase(type);
  const cleanState = normalizeLowercase(state);

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

function normalizeCACRegistrationNumber(value) {
  return normalizeText(value).toUpperCase().replace(/\s+/g, "");
}

function normalizeRegulatoryRegistrationNumber(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function isValidCACRegistrationNumber(value) {
  return /^(RC|BN|IT|LP|LLP)\d{4,10}$/.test(value);
}

function isValidRegulatoryRegistrationNumber(value) {
  return /^[A-Z0-9/ -]{4,30}$/i.test(value);
}

class ProfileInputService {
  static buildProfessionalProfileData(data = {}) {
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

    const cleanType = normalizeLowercase(type);
    const cleanLicenceNumber = normalizeText(licenceNumber);
    const cleanPhoneCode = normalizeText(phoneCode);
    const cleanPhone = normalizeText(phone);
    const cleanSpecialty = normalizeText(specialty);
    const cleanAddress = normalizeText(address);
    const cleanState = normalizeText(state);
    const cleanLga = normalizeText(lga);
    const cleanGooglePlaceId = normalizeText(googlePlaceId);

    assertRequiredFields(
      [
        cleanType,
        cleanLicenceNumber,
        cleanPhoneCode,
        cleanPhone,
        cleanSpecialty,
        cleanAddress,
        cleanState,
        cleanLga,
      ],
      "Missing required professional or location fields."
    );

    validateProfessionalLicenceNumber(cleanType, cleanLicenceNumber);

    if (!cleanGooglePlaceId) {
      throw new Error("Please select a valid address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid address from the suggestions."
    );

    return {
      type: cleanType,
      licenceNumber: cleanLicenceNumber,

      phoneCode: cleanPhoneCode,
      phone: cleanPhone,

      specialty: cleanSpecialty,

      address: cleanAddress,
      googlePlaceId: cleanGooglePlaceId,
      location,
      state: cleanState,
      lga: cleanLga,

      yearsOfExperience: Number(yearsOfExperience) || 0,

      bio: normalizeText(bio),
    };
  }

  static buildEmployerProfileData(data = {}) {
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

    const cleanType = normalizeLowercase(type);
    const cleanBusinessName = normalizeText(businessName);
    const cleanBusinessEmail = normalizeEmail(businessEmail);

    const cleanState = normalizeText(state);
    const cleanLga = normalizeText(lga);
    const cleanAddress = normalizeText(address);
    const cleanGooglePlaceId = normalizeText(googlePlaceId);

    const cleanBusinessPhoneCode = normalizeText(businessPhoneCode);
    const cleanBusinessPhone = normalizeText(businessPhone);

    const cleanContactFirstName = normalizeText(contactFirstName);
    const cleanContactLastName = normalizeText(contactLastName);
    const cleanContactRole = normalizeText(contactRole);
    const cleanContactPhoneCode = normalizeText(contactPhoneCode);
    const cleanContactPhone = normalizeText(contactPhone);

    assertRequiredFields(
      [
        cleanType,
        cleanBusinessName,
        cleanBusinessEmail,
        cacRegistrationNumber,
        regulatoryRegistrationNumber,
        cleanState,
        cleanLga,
        cleanAddress,
        cleanBusinessPhoneCode,
        cleanBusinessPhone,
        cleanContactFirstName,
        cleanContactLastName,
        cleanContactRole,
        cleanContactPhoneCode,
        cleanContactPhone,
      ],
      "Missing required employer profile fields."
    );

    const regulatoryBody = getRegulatoryBody(cleanType, cleanState);

    if (!regulatoryBody) {
      throw new Error("Invalid employer type selected.");
    }

    if (!cleanGooglePlaceId) {
      throw new Error("Please select a valid business address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid business address from the suggestions."
    );

    if (!isValidEmail(cleanBusinessEmail)) {
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

      businessName: cleanBusinessName,
      businessEmail: cleanBusinessEmail,

      cacRegistrationNumber: normalizedCACRegistrationNumber,

      regulatoryBody,
      regulatoryRegistrationNumber: normalizedRegulatoryRegistrationNumber,

      businessPhoneCode: cleanBusinessPhoneCode,
      businessPhone: cleanBusinessPhone,

      address: cleanAddress,
      googlePlaceId: cleanGooglePlaceId,
      location,
      state: cleanState,
      lga: cleanLga,

      contactFirstName: cleanContactFirstName,
      contactLastName: cleanContactLastName,
      contactRole: cleanContactRole,
      contactPhoneCode: cleanContactPhoneCode,
      contactPhone: cleanContactPhone,
    };
  }

  static getRegulatoryBody(type, state) {
    return getRegulatoryBody(type, state);
  }

  static getRegulatoryBodyLabel(regulatoryBody) {
    return regulatoryBodyLabels[regulatoryBody] || "-";
  }

  static getRegulatoryBodyLabels() {
    return { ...regulatoryBodyLabels };
  }
}

module.exports = ProfileInputService;
