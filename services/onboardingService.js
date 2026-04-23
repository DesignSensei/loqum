// services/onboardingService.js

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const logger = require("../utils/logger");

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
      yearsOfExperience,
      bio,
    } = data;

    // 1. Validation Logic
    if (!type || !licenceNumber || !phone || !phoneCode || !specialty || !state || !lga) {
      throw new Error("Missing required professional or location fields");
    }

    // 2. Check for existence (Atomic check)
    const existing = await ProfessionalProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    // 3. Save Profile
    const profile = new ProfessionalProfile({
      user: userId,
      type,
      licenceNumber,
      phoneCode,
      phone,
      specialty,
      address,
      state,
      lga,
      yearsOfExperience: yearsOfExperience || 0,
      bio: bio || "",
    });

    await profile.save();

    // 4. Update User State
    await User.findByIdAndUpdate(userId, {
      isOnboarded: true,
      professionalProfile: profile._id,
    });

    logger.info(`Professional profile created for user: ${userId}`);
    return profile;
  }

  static async completeEmployerOnboarding(
    userId,
    {
      type,
      businessName,
      businessRegistrationNumber,
      businessPhoneCode,
      businessPhone,
      address,
      state,
      lga,
      contactFirstName,
      contactLastName,
      contactPhoneCode,
      contactPhone,
    }
  ) {
    if (!type || !businessName || !businessRegistrationNumber || !state || !lga || !contactPhone)
      throw new Error("All required fields must be filled");

    // Check if profile already exists
    const existing = await EmployerProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    const profile = new EmployerProfile({
      user: userId,
      type,
      businessName,
      businessRegistrationNumber,
      businessPhoneCode,
      businessPhone,
      address,
      state,
      lga,
      contactFirstName,
      contactLastName,
      contactPhoneCode,
      contactPhone,
    });

    await profile.save();

    // Mark user as onboarded
    await User.findByIdAndUpdate(userId, {
      isOnboarded: true,
      employerProfile: profile._id,
    });

    logger.info(`Employer profile created for user: ${userId}`);
    return profile;
  }
}

module.exports = OnboardingService;
