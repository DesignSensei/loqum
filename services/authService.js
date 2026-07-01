// services/authService.js

const User = require("../models/User.js");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const logger = require("../utils/logger");
const EmailService = require("./emailService");

class AuthService {
  /* ---------- Login an existing user ---------- */
  static async loginUser({ email, password }) {
    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();

    if (!normalizedEmail || !password) {
      throw new Error("Invalid email or password");
    }

    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    if (!user) {
      throw new Error("Invalid email or password");
    }

    if (user.authProvider === "google" && !user.password) {
      throw new Error("This account was created with Google. Please sign in with Google.");
    }

    if (!user.password) {
      throw new Error("Password login is not available for this account.");
    }

    const passwordMatches = await bcrypt.compare(password, user.password);

    if (!passwordMatches) {
      throw new Error("Invalid email or password");
    }

    if (!user.isVerified) {
      return {
        requiresEmailVerification: true,
        pendingAuth: {
          userId: user._id,
          email: user.email,
        },
      };
    }

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
      requiresEmailVerification: false,
      requiresTwoFactor: false,
      user,
    };
  }

  /* ---------- Register a new user ---------- */
  static async registerUser({ firstName, lastName, email, password, confirmPassword, role }) {
    try {
      if (!firstName || !lastName || !email || !password || !confirmPassword || !role) {
        throw new Error("All fields are required");
      }

      if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }

      const normalizedEmail = String(email).toLowerCase().trim();

      const existingUser = await User.findOne({ email: normalizedEmail });

      if (existingUser) {
        throw new Error("An account with this email already exists. Please log in instead.");
      }

      const cleanFirstName = String(firstName).trim();
      const cleanLastName = String(lastName).trim();

      const newUser = new User({
        firstName: cleanFirstName,
        lastName: cleanLastName,
        displayName: `${cleanFirstName} ${cleanLastName}`,
        email: normalizedEmail,
        password,
        role,
        authProvider: "local",
        isVerified: false,
        isOnboarded: false,
        twoFactorEnabled: true,
      });

      await newUser.save();

      logger.info(`User registered successfully: ${normalizedEmail}`);

      return newUser;
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.email) {
        throw new Error("An account with this email already exists. Please log in instead.");
      }

      throw error;
    }
  }

  /* ---------- Send 6-digit OTP to Email ---------- */
  static async sendOTP(userId) {
    const user = await User.findById(userId).select("+otp +otpExpiry");

    if (!user) {
      throw new Error("User not found");
    }

    if (user.otpLastSentAt) {
      const secondsSinceLastSent = (Date.now() - user.otpLastSentAt) / 1000;

      if (secondsSinceLastSent < 60) {
        throw new Error("Please wait 60 seconds before requesting another OTP");
      }
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    logger.info(`OTP for ${user.email}: ${otp}`);

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date();

    await user.save();

    await EmailService.sendOTP(user.email, otp);

    return true;
  }

  /* ---------- Verify user's OTP ---------- */
  static async verifyOTP(userId, otp) {
    const user = await User.findById(userId).select("+otp +otpExpiry");

    if (!user) {
      throw new Error("User not found");
    }

    if (user.otpAttempts >= 5) {
      throw new Error("Too many attempts. Please request a new OTP");
    }

    if (!user.otpExpiry || user.otpExpiry < new Date()) {
      throw new Error("OTP has expired. Please request a new one");
    }

    if (user.otp !== String(otp || "").trim()) {
      user.otpAttempts += 1;

      await user.save();

      throw new Error(`Invalid OTP. ${5 - user.otpAttempts} attempts remaining`);
    }

    user.otp = undefined;
    user.otpExpiry = undefined;
    user.otpAttempts = 0;
    user.isVerified = true;

    await user.save();

    return user;
  }

  /* ---------- Send password reset link ---------- */
  static async sendResetLink(email) {
    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      throw new Error("No account found with that email");
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpiry = new Date(Date.now() + 30 * 60 * 1000);

    await user.save();

    const resetUrl = `${process.env.BASE_URL}/new-password?token=${resetToken}`;

    await EmailService.sendResetLink(user.email, resetUrl);

    return true;
  }

  /* ---------- Reset password ---------- */
  static async resetPassword(token, newPassword, confirmPassword) {
    if (!token) {
      throw new Error("Reset token is missing");
    }

    if (!newPassword || !confirmPassword) {
      throw new Error("All fields are required");
    }

    if (newPassword !== confirmPassword) {
      throw new Error("Passwords do not match");
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: new Date() },
    });

    if (!user) {
      throw new Error("Invalid or expired reset link");
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;

    await user.save();

    return true;
  }
}

module.exports = AuthService;
