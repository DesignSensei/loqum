// controllers/accountController.js

const AccountService = require("../services/accountService");
const logger = require("../utils/logger");
const { getPostAuthRedirect } = require("../utils/routeHelper");
const { getCurrentUser, refreshSessionUser, saveSession } = require("../utils/sessionHelper");

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

exports.getSettings = async (req, res, next) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return res.redirect("/login");
    }

    const accountSettingsView = AccountService.buildSettingsView(currentUser, {
      employerMember: req.employerMember,
      employerContext: req.employerContext,
    });

    return res.render("account/settings", {
      layout: "layouts/app-layout",
      title: "Account Settings",

      breadcrumbs: [
        {
          label: "Home",
          url: getPostAuthRedirect(currentUser),
        },
        {
          label: "Account Settings",
        },
      ],

      accountSettingsView,

      scripts: `
        <script src="/js/account/settings.js"></script>
      `,
    });
  } catch (error) {
    next(error);
  }
};

exports.postUpdateProfile = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    const updatedUser = await AccountService.updateProfile({
      userId: currentUser._id,
      data: req.body,
    });

    await refreshSessionUser(req, updatedUser);

    return res.json({
      success: true,
      message: "Contact information updated successfully.",
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Update account profile error:", error);

    return sendBadRequest(res, error.message || "Unable to update contact information.");
  }
};

exports.postUpdateProfilePhoto = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    if (!req.file) {
      return sendBadRequest(res, "Please select a profile photo.");
    }

    const photoUrl = `/uploads/users/${req.file.filename}`;

    const updatedUser = await AccountService.updateProfilePhoto({
      userId: currentUser._id,
      photoUrl,
    });

    await refreshSessionUser(req, updatedUser);

    return res.json({
      success: true,
      message: "Profile photo updated successfully.",
      photoUrl,
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Update profile photo error:", error);

    return sendBadRequest(res, error.message || "Unable to update profile photo.");
  }
};

exports.postUpdatePassword = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    await AccountService.updatePassword({
      userId: currentUser._id,
      data: req.body,
    });

    return res.json({
      success: true,
      message: "Password updated successfully.",
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Update password error:", error);

    return sendBadRequest(res, error.message || "Unable to update password.");
  }
};

exports.postSendChangeEmailOTP = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    const result = await AccountService.sendChangeEmailOTP({
      userId: currentUser._id,
      newEmail: req.body.newEmail,
    });

    req.session.pendingEmailChange = {
      newEmail: result.newEmail,
    };

    await saveSession(req);

    return res.json({
      success: true,
      message: "OTP sent to your new email address.",
    });
  } catch (error) {
    logger.error("Send change email OTP error:", error);

    return sendBadRequest(res, error.message || "Unable to send OTP.");
  }
};

exports.postConfirmEmailChange = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    const pendingEmailChange = req.session.pendingEmailChange;

    if (!pendingEmailChange?.newEmail) {
      return sendBadRequest(res, "No pending email change found.");
    }

    const updatedUser = await AccountService.confirmEmailChange({
      userId: currentUser._id,
      newEmail: pendingEmailChange.newEmail,
      otp: req.body.otp,
    });

    delete req.session.pendingEmailChange;

    await refreshSessionUser(req, updatedUser);

    return res.json({
      success: true,
      message: "Email address updated successfully.",
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Confirm email change error:", error);

    return sendBadRequest(res, error.message || "Unable to update email address.");
  }
};

exports.postSendDisableTwoFactorOTP = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    await AccountService.sendDisableTwoFactorOTP(currentUser._id);

    return res.json({
      success: true,
      message: "OTP sent to your email address.",
    });
  } catch (error) {
    logger.error("Send disable 2FA OTP error:", error);

    return sendBadRequest(res, error.message || "Unable to send OTP.");
  }
};

exports.postDisableTwoFactor = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    const updatedUser = await AccountService.disableTwoFactor({
      userId: currentUser._id,
      otp: req.body.otp,
    });

    await refreshSessionUser(req, updatedUser);

    return res.json({
      success: true,
      message: "Two-factor authentication has been turned off.",
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Disable 2FA error:", error);

    return sendBadRequest(res, error.message || "Unable to turn off two-factor authentication.");
  }
};

exports.postSendEnableTwoFactorOTP = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    await AccountService.sendEnableTwoFactorOTP(currentUser._id);

    return res.json({
      success: true,
      message: "OTP sent to your email address.",
    });
  } catch (error) {
    logger.error("Send enable 2FA OTP error:", error);

    return sendBadRequest(res, error.message || "Unable to send OTP.");
  }
};

exports.postEnableTwoFactor = async (req, res) => {
  try {
    const currentUser = getCurrentUser(req);

    if (!currentUser) {
      return sendBadRequest(res, "You must be logged in.");
    }

    const updatedUser = await AccountService.enableTwoFactor({
      userId: currentUser._id,
      otp: req.body.otp,
    });

    await refreshSessionUser(req, updatedUser);

    return res.json({
      success: true,
      message: "Two-factor authentication has been turned on.",
      redirectUrl: "/account/settings",
    });
  } catch (error) {
    logger.error("Enable 2FA error:", error);

    return sendBadRequest(res, error.message || "Unable to turn on two-factor authentication.");
  }
};
