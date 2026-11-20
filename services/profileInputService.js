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

function normalizeText(value, maxLength = Infinity, multiline = false) {
  if (value === undefined || value === null) return "";

  if (typeof value !== "string") {
    throw new Error("Profile text fields must be strings.");
  }

  // Check before trimming so malformed identifiers cannot be cleaned into validity.
  const controls = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    : /[\u0000-\u001F\u007F]/;

  if (controls.test(value)) {
    throw new Error("Profile text contains invalid control characters.");
  }

  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maxLength) {
    throw new Error("Profile text exceeds the permitted length.");
  }
  return normalized;
}

function assertProfileInput(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(data))
  ) {
    throw new Error("Profile details must be an object.");
  }
}

// Form inputs are decimal strings; API clients may supply finite numbers.
// Never turn blanks, booleans, arrays or objects into numeric values.
function normalizeDecimal(value, message) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      throw new Error(message);
    }
    value = Number(text);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(message);
  }
  return value;
}

function buildProfileLocation(latitude, longitude, message) {
  return buildGeoPoint(
    normalizeDecimal(latitude, message),
    normalizeDecimal(longitude, message),
    message
  );
}

function normalizeExperience(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === ""))
    return 0;
  const message = "Years of experience must be a finite, non-negative number.";
  const years = normalizeDecimal(value, message);
  if (years < 0) throw new Error(message);
  return years;
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
 * ProfessionalVerificationService handles document review and
 * licence readiness after onboarding; regulator checks depend
 * on the professional type.
 */

function validateProfessionalLicenceNumber(type, licenceNumber) {
  if (type === "pharmacist" && !/^\d{6}$/.test(licenceNumber)) {
    throw new Error("PCN licence number must be exactly 6 digits.");
  }
}

// ───────────────────── LEGACY REGULATORY BODY DISPLAY SUPPORT ─────────────────────

/*
 * Retained for existing employer profile display consumers.
 * This returns a suggested label only. It does not determine
 * all permits required for a particular branch or activity.
 * Authoritative requirements belong to facility verification.
 */

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

  const businessName = normalizeText(value, 150).replace(/\s+/g, " ");

  if (!businessName || businessName.length > 150 || /[\u0000-\u001F\u007F]/.test(businessName)) {
    throw new Error("Verified CAC registered business name is invalid.");
  }

  return businessName;
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
    assertProfileInput(data);
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

    if (
      ![
        "pharmacist",
        "pharmacy_technician",
        "nurse",
        "doctor",
        "lab_scientist",
        "radiographer",
        "physiotherapist",
      ].includes(cleanType)
    ) {
      throw new Error("Invalid professional type selected.");
    }

    validateProfessionalLicenceNumber(cleanType, cleanLicenceNumber);

    if (!cleanGooglePlaceId) {
      throw new Error("Please select a valid address from the suggestions.");
    }

    const location = buildProfileLocation(
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

      yearsOfExperience: normalizeExperience(yearsOfExperience),

      bio: normalizeText(bio, 500, true),
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
   * - Contact-person details.
   *
   * Premises permits are submitted after onboarding against
   * the initial or a subsequently added Branch.
   *
   * The registered legal business name must
   * already have been obtained from CAC evidence.
   *
   * OnboardingService supplies that trusted value
   * after successful transactional consumption.
   *
   * Contact details are ordinary employer-submitted data.
   * The builder does not verify the CAC registration or
   * grant facility-permit or marketplace eligibility.
   */

  static buildEmployerProfileData(data = {}) {
    assertProfileInput(data);
    const {
      type,
      businessName,
      businessEmail,
      cacRegistrationNumber,
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
    const cleanBusinessEmail = normalizeEmail(normalizeText(businessEmail, 254));

    const cleanState = normalizeText(state, 100);
    const cleanLga = normalizeText(lga, 100);
    const cleanAddress = normalizeText(address, 250);
    const cleanGooglePlaceId = normalizeText(googlePlaceId, 250);

    const cleanBusinessPhoneCode = normalizeText(businessPhoneCode, 10);
    const cleanBusinessPhone = normalizeText(businessPhone, 30);

    const cleanContactFirstName = normalizeText(contactFirstName, 100);
    const cleanContactLastName = normalizeText(contactLastName, 100);
    const cleanContactRole = normalizeText(contactRole);
    const cleanContactPhoneCode = normalizeText(contactPhoneCode, 10);
    const cleanContactPhone = normalizeText(contactPhone, 30);

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

    if (
      ![
        "owner",
        "director",
        "superintendent_pharmacist",
        "branch_manager",
        "hr_admin",
        "operations_manager",
        "procurement_manager",
        "other",
      ].includes(cleanContactRole)
    ) {
      throw new Error("Invalid contact role selected.");
    }

    // ───────── AUTHORITATIVE BUSINESS NAME ─────────

    const cleanBusinessName = normalizeRegisteredBusinessName(businessName);

    // ───────── EMPLOYER BUSINESS TYPE ─────────

    if (!["pharmacy", "clinic", "hospital", "laboratory"].includes(cleanType)) {
      throw new Error("Invalid employer type selected.");
    }

    // ───────── BUSINESS LOCATION ─────────

    if (!cleanGooglePlaceId) {
      throw new Error("Please select a valid business address from the suggestions.");
    }

    const location = buildProfileLocation(
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

      businessPhoneCode: cleanBusinessPhoneCode,
      businessPhone: cleanBusinessPhone,

      address: cleanAddress,
      googlePlaceId: cleanGooglePlaceId,
      location,
      state: cleanState,
      lga: cleanLga,

      // Contact details are employer-supplied and do not establish
      // regulatory or marketplace approval.

      contactFirstName: cleanContactFirstName,
      contactLastName: cleanContactLastName,
      contactRole: cleanContactRole,
      contactPhoneCode: cleanContactPhoneCode,
      contactPhone: cleanContactPhone,
    };
  }

  // ───────────────────── LEGACY REGULATOR LABEL HELPERS ─────────────────────

  // Retained for existing display callers. Not a permit requirement decision.

  static getRegulatoryBody(type, state) {
    return getRegulatoryBody(type, state);
  }

  static getRegulatoryBodyLabel(regulatoryBody) {
    return typeof regulatoryBody === "string" && Object.hasOwn(regulatoryBodyLabels, regulatoryBody)
      ? regulatoryBodyLabels[regulatoryBody]
      : "-";
  }

  static getRegulatoryBodyLabels() {
    return { ...regulatoryBodyLabels };
  }
}

module.exports = ProfileInputService;
