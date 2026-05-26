// services/onboardingService.js

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const logger = require("../utils/logger");
const { buildGeoPoint } = require("../utils/geo");

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

    const existing = await ProfessionalProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    const profile = new ProfessionalProfile({
      user: userId,
      type,
      licenceNumber: String(licenceNumber).trim(),
      phoneCode,
      phone,
      specialty,
      address: String(address).trim(),
      googlePlaceId: String(googlePlaceId).trim(),
      location,
      state,
      lga,
      yearsOfExperience: yearsOfExperience || 0,
      bio: bio || "",
    });

    await profile.save();

    await User.findByIdAndUpdate(userId, {
      isOnboarded: true,
      professionalProfile: profile._id,
    });

    logger.info(`Professional profile created for user: ${userId}`);
    return profile;
  }

  static async completeEmployerOnboarding(userId, data) {
    const {
      type,
      businessName,
      businessRegistrationNumber,
      businessPhoneCode,
      businessPhone,
      address,
      state,
      lga,
      latitude,
      longitude,
      googlePlaceId,
      contactFirstName,
      contactLastName,
      contactPhoneCode,
      contactPhone,
    } = data;

    if (
      !type ||
      !businessName ||
      !businessRegistrationNumber ||
      !address ||
      !state ||
      !lga ||
      !contactPhone
    ) {
      throw new Error("All required fields must be filled");
    }

    if (!String(googlePlaceId || "").trim()) {
      throw new Error("Please select a valid business address from the suggestions.");
    }

    const location = buildGeoPoint(
      latitude,
      longitude,
      "Please select a valid business address from the suggestions."
    );

    const existing = await EmployerProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    const profile = new EmployerProfile({
      user: userId,
      type,
      businessName,
      businessRegistrationNumber,
      businessPhoneCode,
      businessPhone,
      address: String(address).trim(),
      googlePlaceId: String(googlePlaceId).trim(),
      location,
      state,
      lga,
      contactFirstName,
      contactLastName,
      contactPhoneCode,
      contactPhone,
    });

    await profile.save();

    await User.findByIdAndUpdate(userId, {
      isOnboarded: true,
      employerProfile: profile._id,
    });

    logger.info(`Employer profile created for user: ${userId}`);
    return profile;
  }
}

module.exports = OnboardingService;
