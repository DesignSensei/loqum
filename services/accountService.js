// services/accountService.js

const crypto = require("crypto");

const User = require("../models/User");
const AuthService = require("./authService");
const EmailService = require("./emailService");

class AccountService {
  static normalizeEmail(email) {
    return String(email || "")
      .toLowerCase()
      .trim();
  }

  static isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  static isValidUrl(value) {
    if (!value) return true;

    try {
      const url = new URL(value);

      return ["http:", "https:"].includes(url.protocol);
    } catch (error) {
      return false;
    }
  }

  static isValidProfilePhotoPath(photo) {
    if (!photo) return false;

    if (photo.startsWith("/uploads/users/")) {
      return true;
    }

    try {
      const url = new URL(photo);

      return ["http:", "https:"].includes(url.protocol);
    } catch (error) {
      return false;
    }
  }

  static formatMemberSince(date) {
    if (!date) return "-";

    return new Date(date).toLocaleDateString("en-NG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  static getRoleLabel(role) {
    const roleLabels = {
      admin: "Admin",
      employer: "Employer",
      professional: "Professional",
    };

    return roleLabels[role] || "User";
  }

  static buildSettingsView(user) {
    const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();

    return {
      profileView: {
        firstName: user?.firstName || "",
        lastName: user?.lastName || "",
        displayName: user?.displayName || fullName || user?.email || "User",
        email: user?.email || "",
        photo: user?.photo || "",

        phoneCode: user?.phoneCode || "+234",
        phoneNumber: user?.phoneNumber || "",

        roleLabel: this.getRoleLabel(user?.role),
        memberSinceLabel: this.formatMemberSince(user?.createdAt),

        twoFactorEnabled: Boolean(user?.twoFactorEnabled),
        twoFactorStatusLabel: user?.twoFactorEnabled ? "Enabled" : "Disabled",
        twoFactorStatusClass: user?.twoFactorEnabled
          ? "badge-light-success"
          : "badge-light-secondary",

        updateProfileUrl: "/account/settings/profile/update",
        updatePhotoUrl: "/account/settings/profile/photo",
      },

      securityView: {
        email: user?.email || "",
        authProvider: user?.authProvider || "local",

        hasPasswordLogin: user?.authProvider === "local",
        hasGoogleLogin: user?.authProvider === "google",

        passwordTitle: "Password Management",
        passwordStatusLabel: user?.authProvider === "google" ? "Managed by Google" : "Enabled",
        passwordStatusClass:
          user?.authProvider === "google" ? "badge-light-info" : "badge-light-success",
        passwordDescription:
          user?.authProvider === "google"
            ? "Your account uses Google authentication. Password changes should be made through your Google account."
            : "Update the password used to sign in to your Loqum account.",

        googleLoginStatus: user?.authProvider === "google" ? "Connected" : "Not connected",

        twoFactorEnabled: Boolean(user?.twoFactorEnabled),

        sendEnableTwoFactorOtpUrl: "/account/settings/2fa/send-enable-otp",
        enableTwoFactorUrl: "/account/settings/2fa/enable",

        sendDisableTwoFactorOtpUrl: "/account/settings/2fa/send-disable-otp",
        disableTwoFactorUrl: "/account/settings/2fa/disable",

        changePasswordUrl: "/account/settings/password/update",

        sendChangeEmailOtpUrl: "/account/settings/email/send-change-otp",
        confirmEmailChangeUrl: "/account/settings/email/confirm",
      },

      preferencesView: {
        notificationsStatusText: "Notification preferences will be available soon.",
        themeStatusText: "Theme is currently controlled from the header.",
        languageStatusText: "English is currently the only supported language.",
      },

      sessionsView: {
        currentSessionLabel: "Current session",
        activeDevicesStatusText:
          "Active device management will be available after session tracking is added.",
      },
    };
  }

  static async updateProfile({ userId, data }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    const firstName = String(data.firstName || "").trim();
    const lastName = String(data.lastName || "").trim();
    const phoneCode = String(data.phoneCode || "").trim();
    const phoneNumber = String(data.phoneNumber || "").trim();

    if (!firstName) {
      throw new Error("First name is required.");
    }

    if (!lastName) {
      throw new Error("Last name is required.");
    }

    if (!phoneCode) {
      throw new Error("Phone code is required.");
    }

    if (!phoneNumber) {
      throw new Error("Phone number is required.");
    }

    user.firstName = firstName;
    user.lastName = lastName;
    user.displayName = `${firstName} ${lastName}`.trim();
    user.phoneCode = phoneCode;
    user.phoneNumber = phoneNumber;

    await user.save();

    return user;
  }

  static async updateProfilePhoto({ userId, photoUrl }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const photo = String(photoUrl || "").trim();

    if (!photo) {
      throw new Error("Profile photo is required.");
    }

    if (!this.isValidProfilePhotoPath(photo)) {
      throw new Error("Profile photo path is invalid.");
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    user.photo = photo;

    await user.save();

    return user;
  }

  static async sendChangeEmailOTP({ userId, newEmail }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const normalizedEmail = this.normalizeEmail(newEmail);

    if (!this.isValidEmail(normalizedEmail)) {
      throw new Error("Enter a valid email address.");
    }

    const user = await User.findById(userId).select("+otp +otpExpiry +otpAttempts +otpLastSentAt");

    if (!user) {
      throw new Error("User not found.");
    }

    if (this.normalizeEmail(user.email) === normalizedEmail) {
      throw new Error("This is already your current email address.");
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
      _id: { $ne: user._id },
    });

    if (existingUser) {
      throw new Error("Another account already uses this email address.");
    }

    if (user.otpLastSentAt) {
      const secondsSinceLastSent = (Date.now() - user.otpLastSentAt) / 1000;

      if (secondsSinceLastSent < 60) {
        throw new Error("Please wait 6o seconds before requesting another OTP.");
      }
    }

    const otp = crypto.randomInt(100000, 999999).toString();

    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date();

    await user.save();

    await EmailService.sendOTP(normalizedEmail, otp);

    return {
      newEmail: normalizedEmail,
    };
  }

  static async confirmEmailChange({ userId, newEmail, otp }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const normalizedEmail = this.normalizeEmail(newEmail);

    if (!this.isValidEmail(normalizedEmail)) {
      throw new Error("Enter a valid email address.");
    }

    if (!otp) {
      throw new Error("OTP is required.");
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
      _id: { $ne: userId },
    });

    if (existingUser) {
      throw new Error("Another account already uses this email address.");
    }

    const user = await AuthService.verifyOTP(userId, otp);

    user.email = normalizedEmail;
    user.isVerified = true;

    try {
      await user.save();
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.email) {
        throw new Error("Another account already uses this email address.");
      }

      throw error;
    }

    return user;
  }

  static async sendDisableTwoFactorOTP(userId) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    if (!user.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already disabled.");
    }

    await AuthService.sendOTP(user._id);

    return true;
  }

  static async disableTwoFactor({ userId, otp }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    if (!otp) {
      throw new Error("OTP is required.");
    }

    const existingUser = await User.findById(userId);

    if (!existingUser) {
      throw new Error("User not found.");
    }

    if (!existingUser.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already disabled.");
    }

    const user = await AuthService.verifyOTP(userId, otp);

    user.twoFactorEnabled = false;

    await user.save();

    return user;
  }

  static async sendEnableTwoFactorOTP(userId) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    if (user.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already enabled.");
    }

    await AuthService.sendOTP(user._id);

    return true;
  }

  static async enableTwoFactor({ userId, otp }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    if (!otp) {
      throw new Error("OTP is required.");
    }

    const existingUser = await User.findById(userId);

    if (!existingUser) {
      throw new Error("User not found.");
    }

    if (existingUser.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already enabled.");
    }

    const user = await AuthService.verifyOTP(userId, otp);

    user.twoFactorEnabled = true;

    await user.save();

    return user;
  }
}

module.exports = AccountService;
