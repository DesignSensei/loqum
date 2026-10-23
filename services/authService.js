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

    /*
     * Account restrictions are separate from
     * NIN identity verification, professional
     * licensing and marketplace approval.
     *
     * Suspended, deactivated and banned accounts
     * must not complete ordinary password login.
     *
     * Restricted accounts may still authenticate
     * where the application's access middleware
     * permits limited account functionality.
     */

    if (["suspended", "deactivated", "banned"].includes(user.accountStatus)) {
      throw new Error("This account is not currently permitted to sign in.");
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

  /*
   * REGISTRATION AND LEGAL NAME POLICY
   *
   * Professional registration requires only
   * account credentials and the professional role.
   *
   * Professionals do not enter their legal
   * firstName, middleName or lastName during
   * initial account registration.
   *
   * Their legal names must later come from
   * structured production NIN registry evidence
   * through the trusted onboarding workflow.
   *
   * NIN lookup and acknowledgement are separate
   * from email verification and account creation.
   *
   * A successful NIN lookup establishes that
   * the submitted NIN exists in the registry.
   * It does not independently authenticate
   * the person operating the Loqum account.
   *
   * Employer registration still collects the
   * account holder's first and last names.
   *
   * Those names are distinct from the employer's
   * CAC-registered legal business name, which
   * is established during employer onboarding.
   *
   * Public registration must never be allowed
   * to create an administrator account.
   */

  static async registerUser({ firstName, lastName, email, password, confirmPassword, role } = {}) {
    try {
      const cleanRole = String(role || "")
        .trim()
        .toLowerCase();

      // ───────── REGISTRATION ROLE ─────────

      if (!["professional", "employer"].includes(cleanRole)) {
        throw new Error("Please select a valid account type.");
      }

      // ───────── ACCOUNT CREDENTIALS ─────────

      if (
        typeof email !== "string" ||
        !email.trim() ||
        typeof password !== "string" ||
        !password ||
        typeof confirmPassword !== "string" ||
        !confirmPassword
      ) {
        throw new Error("All fields are required");
      }

      if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }

      const normalizedEmail = email.toLowerCase().trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error("Enter a valid email address.");
      }

      // ───────── PROFESSIONAL LEGAL NAME PROTECTION ─────────

      /*
       * Reject submitted professional legal names
       * rather than storing them temporarily.
       *
       * This applies even when a client attempts
       * to submit the old registration fields.
       *
       * The professional registration controller
       * and frontend must stop collecting names.
       *
       * The User model also prevents unverified
       * professional accounts from retaining
       * manually entered legal-name fields.
       */

      if (cleanRole === "professional") {
        if (String(firstName ?? "").trim() || String(lastName ?? "").trim()) {
          throw new Error(
            "Professional registration does not accept manually entered legal names. Your legal name will be obtained through NIN verification during onboarding."
          );
        }
      }

      // ───────── EMPLOYER ACCOUNT-HOLDER NAMES ─────────

      /*
       * Employer account-holder names remain
       * required for ordinary registration.
       *
       * These fields do not establish the legal
       * name of the employer's registered business.
       */

      let cleanFirstName = "";
      let cleanLastName = "";
      let cleanDisplayName = "";

      if (cleanRole === "employer") {
        if (
          typeof firstName !== "string" ||
          typeof lastName !== "string" ||
          !firstName.trim() ||
          !lastName.trim()
        ) {
          throw new Error("All fields are required");
        }

        cleanFirstName = firstName.trim();
        cleanLastName = lastName.trim();

        cleanDisplayName = `${cleanFirstName} ${cleanLastName}`;
      }

      // ───────── EXISTING EMAIL CHECK ─────────

      const existingUser = await User.findOne({ email: normalizedEmail });

      if (existingUser) {
        throw new Error("An account with this email already exists. Please log in instead.");
      }

      // ───────── CREATE ACCOUNT ─────────

      /*
       * Professional legal names remain empty.
       *
       * legalNameSource stays unverified until
       * OnboardingService consumes eligible,
       * acknowledged NIN registry evidence.
       *
       * The permanent NIN KYC evidence reference
       * is assigned within that onboarding
       * transaction, not during registration.
       *
       * Employer account-holder names are stored
       * as unverified account information.
       *
       * No profile approval, licence verification
       * or marketplace eligibility is granted here.
       */

      const newUser = new User({
        firstName: cleanFirstName,
        middleName: "",
        lastName: cleanLastName,

        displayName: cleanDisplayName,

        legalNameSource: "unverified",
        legalNameEvidence: null,

        email: normalizedEmail,
        password,
        role: cleanRole,

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

  /*
   * Email OTP verification is separate from
   * NIN identity and professional licensing.
   *
   * OTP values must not be written to logs.
   *
   * Retain the existing 60-second resend
   * restriction and 10-minute OTP validity.
   */

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

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date();

    await user.save();

    /*
     * Deliver the OTP through the configured
     * email provider.
     *
     * Never log the OTP or expose it through
     * the registration response.
     */

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

    /*
     * isVerified establishes successful
     * email/account verification only.
     *
     * It must never be interpreted as
     * NIN-holder authentication, PCN licence
     * verification or marketplace approval.
     */

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
