// public/services/authService.js

const User = require("../models/User.js");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const logger = require("../utils/logger");
const EmailService = require("./emailService");

class AuthService {
  // Login an existing user
  static async loginUser({ email, password }) {
    const user = await User.findOne({ email }).select("+password");
    if (!user) throw new Error("Invalid email or password");

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) throw new Error("Invalid email or password");

    if (user.twoFactorEnabled) {
      return {
        requiresTwoFactor: true,
        pendingAuth: {
          userId: user._id,
          email: user.email,
        },
      };
    }

    return {
      requiresTwoFactor: false,
      user,
    };
  }

  // Register a new user
  static async registerUser({
    firstName,
    lastName,
    email,
    password,
    confirmPassword,
    role,
  }) {
    // Validate input (ensure all fields are provided)
    if (
      !firstName ||
      !lastName ||
      !email ||
      !password ||
      !confirmPassword ||
      !role
    )
      throw new Error("All fields are required");

    if (password !== confirmPassword) throw new Error("Passwords do not match");

    // Check if user is existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) throw new Error("User with this email already exists");

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user instance
    const newUser = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role,
      isVerified: false,
      twoFactorEnabled: false,
    });

    await newUser.save();
    logger.info(`User registered successfully: ${email}`);
    return newUser;
  }

  static async sendOTP(userId) {
    const user = await User.findById(userId).select("+otp +otpExpiry");
    if (!user) throw new Error("User not found");

    // Rate limit
    if (user.otpLastSentAt) {
      const secondsSinceLastSent = (Date.now() - user.otpLastSentAt) / 1000;
      if (secondsSinceLastSent < 60)
        throw new Error("Please wait before requesting another OTP");
    }

    // Generate OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    logger.info(`OTP for ${user.email}: ${otp}`);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date();
    await user.save();

    await EmailService.sendOTP(user.email, otp);
    return true;
  }

  static async verifyOTP(userId, otp) {
    const user = await User.findById(userId).select("+otp +otpExpiry");
    if (!user) throw new Error("User not found");

    if (user.otpAttempts >= 5)
      throw new Error("Too many attempts. Please request a new OTP");

    if (!user.otpExpiry || user.otpExpiry < new Date())
      throw new Error("OTP has expired. Please request a new one");

    if (user.otp !== otp) {
      user.otpAttempts += 1;
      await user.save();
      throw new Error(
        `Invalid OTP. ${5 - user.otpAttempts} attempts remaining`,
      );
    }

    // Clear OTP and mark as verified
    user.otp = undefined;
    user.otpExpiry = undefined;
    user.otpAttempts = 0;
    user.isVerified = true;
    await user.save();

    return user;
  }
}

module.exports = AuthService;
