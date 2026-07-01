// services/onboardingService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");

const logger = require("../utils/logger");

const walletService = require("./walletService");
const DVAService = require("./dvaService");
const ProfileInputService = require("./profileInputService");

class OnboardingService {
  static async completeProfessionalOnboarding(userId, data) {
    const profileData = ProfileInputService.buildProfessionalProfileData(data);

    const session = await mongoose.startSession();

    let profile;
    let wallet;

    try {
      await session.withTransaction(async () => {
        profile = await ProfessionalProfile.findOneAndUpdate(
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
            session,
          }
        );

        wallet = await walletService.createProfessionalWalletIfMissing(profile, { session });

        await User.findByIdAndUpdate(
          userId,
          {
            isOnboarded: true,
            professionalProfile: profile._id,
          },
          {
            returnDocument: "after",
            runValidators: true,
            session,
          }
        );
      });

      logger.info(`Professional wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);
      logger.info(`Professional profile completed for user: ${userId}`);

      return profile;
    } finally {
      await session.endSession();
    }
  }

  static async completeEmployerOnboarding(userId, data) {
    const profileData = ProfileInputService.buildEmployerProfileData(data);

    const session = await mongoose.startSession();

    let profile;
    let wallet;

    try {
      await session.withTransaction(async () => {
        profile = await EmployerProfile.findOneAndUpdate(
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
            session,
          }
        );

        wallet = await walletService.createEmployerWalletIfMissing(profile, { session });

        await User.findByIdAndUpdate(
          userId,
          {
            isOnboarded: true,
            employerProfile: profile._id,
          },
          {
            returnDocument: "after",
            runValidators: true,
            session,
          }
        );
      });

      logger.info(`Employer wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);

      try {
        await DVAService.createEmployerDVA({
          userId,
          employerProfileId: profile._id,
        });

        logger.info(`Employer DVA created for profile: ${profile._id}`);
      } catch (error) {
        logger.error(`Employer DVA creation failed for profile ${profile._id}: ${error.message}`);
      }

      logger.info(`Employer profile completed for user: ${userId}`);

      return profile;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = OnboardingService;
