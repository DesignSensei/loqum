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

  static isStrongPassword(password) {
    const value = String(password || "");

    return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
  }

  static formatMemberSince(date) {
    if (!date) return "-";

    return new Date(date).toLocaleDateString("en-NG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  static getAccountTypeLabel(role) {
    const accountTypeLabels = {
      admin: "Admin",
      employer: "Employer",
      professional: "Professional",
    };

    return accountTypeLabels[role] || "User";
  }

  static getTeamRoleLabel({ user, employerMember, employerContext } = {}) {
    if (user?.role !== "employer") {
      return "None";
    }

    if (employerContext?.isPrimaryEmployer) {
      return "Owner";
    }

    const role = employerContext?.employerMemberRole || employerMember?.role;

    const teamRoleLabels = {
      owner: "Owner",
      admin: "Admin",
      employer_admin: "Admin",
      branch_manager: "Branch Manager",
      branch_staff: "Branch Staff",
      team_member: "Team Member",
    };

    return teamRoleLabels[role] || "Not assigned";
  }

  static buildSettingsView(user, options = {}) {
    const employerMember = options.employerMember || null;
    const employerContext = options.employerContext || null;

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

        accountTypeLabel: this.getAccountTypeLabel(user?.role),
        teamRoleLabel: this.getTeamRoleLabel({
          user,
          employerMember,
          employerContext,
        }),
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
        notificationsStatusText:
          "Choose how you receive account, shift, wallet, and team updates. Notification controls will be available soon.",
        themeStatusText: "Choose how Loqum appears on this device.",
      },

      sessionsView: {
        currentSessionLabel: "Current session",
        currentSessionStatusLabel: "Active",
        currentSessionDescription: "You are currently signed in on this device.",
        activeDevicesStatusText:
          "Active device management will be available after session tracking is added.",
        showManageDevicesButton: false,
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

  static async updatePassword({ userId, data }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const currentPassword = String(data.currentPassword || "");
    const newPassword = String(data.newPassword || "");
    const confirmPassword = String(data.confirmPassword || "");

    if (!currentPassword) {
      throw new Error("Current password is required.");
    }

    if (!newPassword) {
      throw new Error("New password is required.");
    }

    if (!confirmPassword) {
      throw new Error("Please confirm your new password.");
    }

    if (newPassword !== confirmPassword) {
      throw new Error("New password and confirmation do not match.");
    }

    if (!this.isStrongPassword(newPassword)) {
      throw new Error(
        "Password must be at least 8 characters and include uppercase, lowercase, and a number."
      );
    }

    const user = await User.findById(userId).select("+password");

    if (!user) {
      throw new Error("User not found.");
    }

    if (user.authProvider === "google") {
      throw new Error(
        "This account uses Google login. Password changes should be made through Google."
      );
    }

    if (!user.password) {
      throw new Error("Password login is not enabled for this account.");
    }

    const isCurrentPasswordValid = await user.comparePassword(currentPassword);

    if (!isCurrentPasswordValid) {
      throw new Error("Current password is incorrect.");
    }

    const isSamePassword = await user.comparePassword(newPassword);

    if (isSamePassword) {
      throw new Error("New password must be different from your current password.");
    }

    user.password = newPassword;

    await user.save();

    return true;
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
