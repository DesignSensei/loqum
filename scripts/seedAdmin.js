// scripts/seedAdmin.js

require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const logger = require("../utils/logger");

async function seedAdmin(email, password) {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ email });
  if (existing) {
    logger.info(`User with ${email} already exists`);
    await mongoose.disconnect();
    return;
  }

  await User.create({
    email,
    password: await bcrypt.hash(password, 12),
    role: "admin",
    isOnboarded: true,
    isVerified: true,
  });

  logger.info(`Admin created: ${email}`);
  await mongoose.disconnect();
}

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  logger.error("Usage: node scripts/seedAdmin.js <email> <password>");
  process.exit(1);
}

seedAdmin(email, password);
