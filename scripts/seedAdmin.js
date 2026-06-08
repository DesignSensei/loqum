// scripts/seedAdmin.js

require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");
const logger = require("../utils/logger");

async function seedAdmin(email, password) {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail });

    if (existing) {
      existing.role = "admin";
      existing.authProvider = "local";
      existing.password = password;
      existing.isOnboarded = true;
      existing.isVerified = true;

      if (!existing.firstName) existing.firstName = "Loqum";
      if (!existing.lastName) existing.lastName = "Admin";
      if (!existing.displayName) existing.displayName = "Loqum Admin";

      await existing.save();

      logger.info(`Existing user updated to admin: ${normalizedEmail}`);
      return;
    }

    await User.create({
      firstName: "Loqum",
      lastName: "Admin",
      displayName: "Loqum Admin",
      email: normalizedEmail,
      password,
      authProvider: "local",
      role: "admin",
      isOnboarded: true,
      isVerified: true,
    });

    logger.info(`Admin created: ${normalizedEmail}`);
  } catch (error) {
    logger.error(`Failed to seed admin: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  logger.error("Usage: node scripts/seedAdmin.js <email> <password>");
  process.exit(1);
}

seedAdmin(email, password);
