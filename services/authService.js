// services/authService.js

const User = require("../models/User.js");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const logger = require("../utils/logger");
const EmailService = require("./emailService");

class AuthService {
  /* ---------- Login an existing user ---------- */

  static async loginUser({ email, password } = {}) {
    if (typeof email !== "string" || typeof password !== "string") {
      throw new Error("Invalid email or password");
    }
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

  static async registerUser({
    firstName,
    middleName,
    lastName,
    email,
    password,
    confirmPassword,
    role,
  } = {}) {
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
        if (
          [firstName, middleName, lastName].some(
            (name) => name != null && (typeof name !== "string" || name.trim().length > 0)
          )
        ) {
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

  static getOTPRequirements(purpose) {
    switch (purpose) {
      case "email_verification":
      case "signup_invite_verification":
        return { isVerified: false };
      case "login_2fa":
      case "disable_2fa":
        return { isVerified: true, twoFactorEnabled: true };
      case "enable_2fa":
        return { isVerified: true, twoFactorEnabled: false };
      default:
        throw new Error("A valid OTP purpose is required.");
    }
  }

  static getOTPContext(user, { purpose, email } = {}) {
    const requirements = this.getOTPRequirements(purpose);
    const expectedEmail = typeof email === "string" ? email.toLowerCase().trim() : "";
    const accountEmail = String(user.email || "")
      .toLowerCase()
      .trim();

    if (!expectedEmail || expectedEmail !== accountEmail) {
      throw new Error("Your verification context changed. Please start this action again.");
    }

    if (Object.entries(requirements).some(([field, value]) => user[field] !== value)) {
      throw new Error("This OTP action is no longer available. Please start again.");
    }

    return { purpose, email: accountEmail, requirements };
  }

  static buildOTPChallenge({ userId, email, purpose, nonce, otp }) {
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(["auth_otp:v1", String(userId), email, purpose, nonce, otp]))
      .digest("hex");

    return `auth_otp:v1:${purpose}:${nonce}:${digest}`;
  }

  static async sendOTP(userId, options = {}) {
    this.getOTPRequirements(options.purpose);
    const now = new Date();
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");
    if (!["active", "restricted"].includes(user.accountStatus)) {
      throw new Error("This account is not currently permitted to sign in.");
    }

    const context = this.getOTPContext(user, options);
    const otp = crypto.randomInt(100000, 1000000).toString();
    const challenge = this.buildOTPChallenge({
      userId: user._id,
      email: context.email,
      purpose: context.purpose,
      nonce: crypto.randomBytes(16).toString("hex"),
      otp,
    });
    const otpExpiry = new Date(now.getTime() + 10 * 60 * 1000);

    // Only one concurrent resend may claim the 60-second window.
    // Increment the version so older document saves cannot overwrite it.
    const claimed = await User.findOneAndUpdate(
      {
        _id: user._id,
        email: user.email,
        accountStatus: { $in: ["active", "restricted"] },
        ...context.requirements,
        $or: [
          { otpLastSentAt: null },
          { otpLastSentAt: { $lte: new Date(now.getTime() - 60 * 1000) } },
        ],
      },
      {
        $set: { otp: challenge, otpExpiry, otpAttempts: 0, otpLastSentAt: now },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    );

    if (!claimed) {
      throw new Error(
        "OTP request could not be claimed. Please wait 60 seconds before trying again."
      );
    }

    // Send only after the claim succeeds. A delivery failure does not reset
    // the resend window or trigger an automatic second email.
    await EmailService.sendOTP(claimed.email, otp);
    return true;
  }

  /* ---------- Verify user's OTP ---------- */

  static async verifyOTP(userId, otp, options = {}) {
    this.getOTPRequirements(options.purpose);
    const user = await User.findById(userId).select("+otp +otpExpiry");
    if (!user) throw new Error("User not found");
    if (!["active", "restricted"].includes(user.accountStatus)) {
      throw new Error("This account is not currently permitted to sign in.");
    }
    if (user.otpAttempts >= 5) {
      throw new Error("Too many attempts. Please request a new OTP");
    }

    const now = new Date();
    if (!user.otp || !user.otpExpiry || user.otpExpiry <= now) {
      throw new Error("OTP has expired. Please request a new one");
    }

    const context = this.getOTPContext(user, options);
    const parts = String(user.otp).split(":");

    // Reject legacy plain codes and challenges issued for another action.
    // Existing codes must be resent after deploying this format.
    if (
      parts.length !== 5 ||
      parts[0] !== "auth_otp" ||
      parts[1] !== "v1" ||
      parts[2] !== context.purpose ||
      !/^[a-f0-9]{32}$/.test(parts[3]) ||
      !/^[a-f0-9]{64}$/.test(parts[4])
    ) {
      throw new Error("This OTP is not valid for this action. Please request a new one.");
    }

    const candidate = typeof otp === "string" || typeof otp === "number" ? String(otp).trim() : "";
    const expected = this.buildOTPChallenge({
      userId: user._id,
      email: context.email,
      purpose: context.purpose,
      nonce: parts[3],
      otp: candidate,
    });
    const matches =
      /^\d{6}$/.test(candidate) &&
      crypto.timingSafeEqual(Buffer.from(user.otp), Buffer.from(expected));

    // Bind the update to the exact challenge read above. A resend, expiry,
    // account restriction or earlier successful verification must win safely.
    const filter = {
      _id: user._id,
      email: user.email,
      accountStatus: { $in: ["active", "restricted"] },
      ...context.requirements,
      otp: user.otp,
      otpLastSentAt: user.otpLastSentAt || null,
      otpExpiry: { $eq: user.otpExpiry, $gt: new Date() },
      otpAttempts: { $lt: 5 },
    };

    if (!matches) {
      const failed = await User.findOneAndUpdate(
        filter,
        {
          $inc: { otpAttempts: 1, __v: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!failed) throw new Error("OTP is no longer available. Please request a new one.");
      throw new Error(`Invalid OTP. ${5 - failed.otpAttempts} attempts remaining`);
    }

    const updates = { otpAttempts: 0 };
    if (["email_verification", "signup_invite_verification"].includes(context.purpose)) {
      updates.isVerified = true;
    } else if (context.purpose === "enable_2fa") {
      updates.twoFactorEnabled = true;
    } else if (context.purpose === "disable_2fa") {
      updates.twoFactorEnabled = false;
    }

    // Consume the challenge and apply only its intended action atomically.
    const verified = await User.findOneAndUpdate(
      filter,
      {
        $set: updates,
        $unset: { otp: 1, otpExpiry: 1 },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    );
    if (!verified) throw new Error("OTP is no longer available. Please request a new one.");

    // Email verification never grants NIN ownership, licence verification
    // or marketplace approval.
    return verified;
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
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error("Invalid or missing reset token");
    }

    if (
      typeof newPassword !== "string" ||
      !newPassword ||
      typeof confirmPassword !== "string" ||
      !confirmPassword
    ) {
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

    // Reset fields are cleared on save; optimistic concurrency
    // rejects another save that already consumed or replaced this token.
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;

    await user.save();

    return true;
  }
}

module.exports = AuthService;
