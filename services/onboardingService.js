// services/onboardingService.js

const PharmacistProfile = require("../models/PharmacistProfile");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const logger = require("../utils/logger");

class OnboardingService {
  static async completePharmacistOnboarding(userId, data) {
    const {
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
    if (!licenceNumber || !phone || !phoneCode || !state || !lga) {
      throw new Error("Missing required professional or location fields");
    }

    // 2. Check for existence (Atomic check)
    const existing = await PharmacistProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    // 3. Save Profile
    const profile = new PharmacistProfile({
      user: userId,
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
      pharmacistProfile: profile._id,
    });

    logger.info(`Pharmacist profile created for user: ${userId}`);
    return profile;
  }

  static async completeEmployerOnboarding(
    userId,
    {
      pharmacyName,
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
    },
  ) {
    if (
      !pharmacyName ||
      !businessRegistrationNumber ||
      !state ||
      !lga ||
      !contactPhone
    )
      throw new Error("All required fields must be filled");

    // Check if profile already exists
    const existing = await EmployerProfile.findOne({ user: userId });
    if (existing) throw new Error("Profile already exists");

    const profile = new EmployerProfile({
      user: userId,
      pharmacyName,
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
