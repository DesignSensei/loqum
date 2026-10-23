// services/profileInputService.js

const { buildGeoPoint } = require("../utils/geo");

const regulatoryBodyLabels = {
  pcn: "Pharmacists Council of Nigeria",
  hefamaa: "Health Facilities Monitoring and Accreditation Agency",
  state_moh: "State Ministry of Health",
  mlscn: "Medical Laboratory Science Council of Nigeria",
  other: "Other Regulatory Body",
};

// ───────────────────── TEXT NORMALIZATION ─────────────────────

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

// ───────────────────── PROFESSIONAL LICENCE VALIDATION ─────────────────────

/*
 * The professional supplies their licence number
 * as part of their professional profile.
 *
 * Format validation does not establish that
 * the applicant owns the licence.
 *
 * ProfessionalVerificationService remains
 * responsible for independent PCN verification
 * and subsequent professional approval.
 */

function validateProfessionalLicenceNumber(type, licenceNumber) {
  if (type === "pharmacist" && !/^\d{6}$/.test(licenceNumber)) {
    throw new Error("PCN licence number must be exactly 6 digits.");
  }
}

// ───────────────────── REGULATORY BODY SUPPORT ─────────────────────

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

// ───────────────────── CAC REGISTRATION VALIDATION ─────────────────────

/*
 * The current automated CAC onboarding workflow
 * supports RC and BN registrations.
 *
 * Ninja currently supports RC registrations.
 * Dojah is configured to support RC and BN.
 *
 * Provider-specific registration support
 * is checked by CACVerificationService before
 * an external lookup is attempted.
 *
 * IT, LP and LLP registrations must not be
 * accepted as automatically verifiable through
 * the current pre-onboarding CAC workflow.
 */

function normalizeCACRegistrationNumber(value) {
  return normalizeText(value).toUpperCase().replace(/[\s-]/g, "");
}

function isValidCACRegistrationNumber(value) {
  return /^(RC|BN)\d{4,10}$/.test(value);
}

// ───────────────────── REGISTERED BUSINESS NAME ─────────────────────

/*
 * EmployerProfile.businessName is the legal name
 * returned by trusted CAC registry evidence.
 *
 * The onboarding service must validate and consume
 * successful production CAC evidence before calling
 * buildEmployerProfileData().
 *
 * The businessName argument received by this builder
 * must already have been replaced with that trusted
 * registry-derived value.
 *
 * This builder validates the name's shape, but it
 * cannot independently prove registry provenance.
 *
 * Controllers must not use this builder to persist
 * a user-submitted legal business name directly.
 *
 * An optional public trading or display name is
 * separate from the registered legal business name.
 *
 * Do not silently truncate or fabricate CAC names.
 */

function normalizeRegisteredBusinessName(value) {
  if (typeof value !== "string") {
    throw new Error("Verified CAC registered business name is required.");
  }

  const businessName = value.trim();

  if (!businessName || businessName.length > 150 || /[\u0000-\u001F\u007F]/.test(businessName)) {
    throw new Error("Verified CAC registered business name is invalid.");
  }

  return businessName;
}

// ───────────────────── REGULATORY REGISTRATION VALIDATION ─────────────────────

function normalizeRegulatoryRegistrationNumber(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function isValidRegulatoryRegistrationNumber(value) {
  return /^[A-Z0-9/ -]{4,30}$/i.test(value);
}

class ProfileInputService {
  // ───────────────────── PROFESSIONAL PROFILE DATA ─────────────────────

  /*
   * Build ordinary professional profile information.
   *
   * Professional legal names do not originate
   * from this request.
   *
   * The applicant's:
   *
   * - firstName;
   * - middleName;
   * - lastName;
   *
   * must come from acknowledged, trusted NIN
   * registry evidence during onboarding.
   *
   * This method does not accept or return
   * legal-name fields.
   *
   * Professional licence ownership and final
   * marketplace eligibility are separate checks.
   */

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

  // ───────────────────── EMPLOYER PROFILE DATA ─────────────────────

  /*
   * Build employer profile information using
   * the CAC-authoritative registered business name.
   *
   * The applicant provides:
   *
   * - CAC registration number;
   * - Business contact information;
   * - Business location;
   * - Regulatory premises information;
   * - Representative contact details.
   *
   * The registered legal business name must
   * already have been obtained from CAC evidence.
   *
   * OnboardingService supplies that trusted value
   * after successful transactional consumption.
   *
   * Representative names are contact declarations.
   * They do not establish representative authority
   * or replace separate identity checks.
   *
   * The builder does not grant CAC, regulatory,
   * representative or administrative approval.
   */

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

    /*
     * Validate the ordinary applicant-provided
     * fields separately from the authoritative
     * CAC registered business name.
     *
     * The business name is still required for
     * EmployerProfile persistence, but it is
     * supplied by the trusted onboarding workflow,
     * not manually entered by the applicant.
     */

    assertRequiredFields(
      [
        cleanType,
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

    // ───────── AUTHORITATIVE BUSINESS NAME ─────────

    const cleanBusinessName = normalizeRegisteredBusinessName(businessName);

    // ───────── REGULATORY BODY ─────────

    const regulatoryBody = getRegulatoryBody(cleanType, cleanState);

    if (!regulatoryBody) {
      throw new Error("Invalid employer type selected.");
    }

    // ───────── BUSINESS LOCATION ─────────

    if (!cleanGooglePlaceId) {
      throw new Error("Please select a valid business address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid business address from the suggestions."
    );

    // ───────── BUSINESS EMAIL ─────────

    if (!isValidEmail(cleanBusinessEmail)) {
      throw new Error("Enter a valid business email address.");
    }

    // ───────── CAC REGISTRATION NUMBER ─────────

    const normalizedCACRegistrationNumber = normalizeCACRegistrationNumber(cacRegistrationNumber);

    if (!isValidCACRegistrationNumber(normalizedCACRegistrationNumber)) {
      throw new Error("Enter a valid CAC number, e.g. RC1234567 or BN1234567.");
    }

    // ───────── REGULATORY REGISTRATION NUMBER ─────────

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

      /*
       * The registered business name is the
       * CAC-derived value injected by the
       * trusted onboarding workflow.
       */

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

      /*
       * Contact names remain user-provided
       * declarations until separately reviewed.
       */

      contactFirstName: cleanContactFirstName,
      contactLastName: cleanContactLastName,
      contactRole: cleanContactRole,
      contactPhoneCode: cleanContactPhoneCode,
      contactPhone: cleanContactPhone,
    };
  }

  // ───────────────────── REGULATORY BODY HELPERS ─────────────────────

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
