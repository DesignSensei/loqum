// services/onboardingService.js

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const Wallet = require("../models/Wallet");
// const DVAService = require("./dvaService");
const User = require("../models/User");
const logger = require("../utils/logger");
const { buildGeoPoint } = require("../utils/geo");

const normalizeCACRegistrationNumber = (value) => {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
};

const normalizeRegulatoryRegistrationNumber = (value) => {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
};

const isValidCACRegistrationNumber = (value) => {
  return /^(RC|BN|IT|LP|LLP)\d{4,10}$/i.test(value);
};

const isValidRegulatoryRegistrationNumber = (value) => {
  return /^[A-Z0-9/\\\- ]{4,30}$/i.test(value);
};

class OnboardingService {
  static async completeProfessionalOnboarding(userId, data) {
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

    if (
      !type ||
      !licenceNumber ||
      !phone ||
      !phoneCode ||
      !specialty ||
      !address ||
      !state ||
      !lga
    ) {
      throw new Error("Missing required professional or location fields");
    }

    if (type === "pharmacist" && !/^[0-9]{6}$/.test(String(licenceNumber).trim())) {
      throw new Error("PCN licence number must be exactly 6 digits.");
    }

    if (!String(googlePlaceId || "").trim()) {
      throw new Error("Please select a valid address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid address from the suggestions."
    );

    const profileData = {
      type,
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

    const profile = await ProfessionalProfile.findOneAndUpdate(
      { user: userId },
      {
        $set: profileData,
        $setOnInsert: {
          user: userId,
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        context: "query",
      }
    );

    await User.findByIdAndUpdate(
      userId,
      {
        isOnboarded: true,
        professionalProfile: profile._id,
      },
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    logger.info(`Professional profile completed for user: ${userId}`);

    return profile;
  }

  static async completeEmployerOnboarding(userId, data) {
    const {
      type,
      businessName,
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

    const regulatoryBodyByType = {
      pharmacy: "pcn",
      clinic: "state_moh",
      hospital: "state_moh",
      laboratory: "mlscn",
    };

    const regulatoryBody = regulatoryBodyByType[type];

    if (!regulatoryBody) {
      throw new Error("Invalid employer type selected.");
    }

    if (
      !type ||
      !businessName ||
      !cacRegistrationNumber ||
      !regulatoryRegistrationNumber ||
      !state ||
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
      throw new Error("Missing required employer onboarding fields");
    }

    if (!String(googlePlaceId || "").trim()) {
      throw new Error("Please select a valid business address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid business address from the suggestions."
    );

    const normalizedCACRegistrationNumber = normalizeCACRegistrationNumber(cacRegistrationNumber);

    const normalizedRegulatoryRegistrationNumber = normalizeRegulatoryRegistrationNumber(
      regulatoryRegistrationNumber
    );

    if (!isValidCACRegistrationNumber(normalizedCACRegistrationNumber)) {
      throw new Error("Enter a valid CAC number, e.g. RC1234567 or BN1234567.");
    }

    if (!isValidRegulatoryRegistrationNumber(normalizedRegulatoryRegistrationNumber)) {
      throw new Error(
        "Enter the PCN premises registration number exactly as shown on the certificate."
      );
    }

    const profileData = {
      type: String(type).trim(),
      businessName: String(businessName).trim(),

      cacRegistrationNumber: normalizedCACRegistrationNumber,

      regulatoryBody,
      regulatoryRegistrationNumber: normalizedRegulatoryRegistrationNumber,

      businessPhoneCode: String(businessPhoneCode).trim(),
      businessPhone: String(businessPhone).trim(),

      address: String(address).trim(),
      googlePlaceId: String(googlePlaceId).trim(),
      location,
      state: String(state).trim(),
      lga: String(lga).trim(),

      contactFirstName: String(contactFirstName).trim(),
      contactLastName: String(contactLastName).trim(),
      contactRole: String(contactRole).trim(),
      contactPhoneCode: String(contactPhoneCode).trim(),
      contactPhone: String(contactPhone).trim(),
    };

    const profile = await EmployerProfile.findOneAndUpdate(
      { user: userId },
      {
        $set: profileData,
        $setOnInsert: {
          user: userId,
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        context: "query",
      }
    );

    const wallet = await Wallet.findOneAndUpdate(
      {
        ownerType: "employer",
        employer: profile._id,
      },
      {
        $setOnInsert: {
          ownerType: "employer",
          employer: profile._id,
          currency: "NGN",
          availableBalance: 0,
          pendingBalance: 0,
          outstandingBalance: 0,
          status: "active",
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        context: "query",
      }
    );

    logger.info(`Employer wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);

    // DVA creation is temporarily disabled until Paystack merchant approval.
    // Once Paystack approves the account, uncomment this block.

    /*
try {
  await DVAService.createEmployerDVA({
    userId,
    employerProfileId: profile._id,
  });

  logger.info(`Employer DVA created for profile: ${profile._id}`);
} catch (error) {
  logger.error(`Employer DVA creation failed for profile ${profile._id}: ${error.message}`);
}
*/

    await User.findByIdAndUpdate(
      userId,
      {
        isOnboarded: true,
        employerProfile: profile._id,
      },
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    logger.info(`Employer profile completed for user: ${userId}`);

    return profile;
  }
}

module.exports = OnboardingService;
