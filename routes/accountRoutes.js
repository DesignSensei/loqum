// routes/accountRoutes.js

const express = require("express");
const router = express.Router();

const accountController = require("../controllers/accountController");
const { uploadUserPhoto } = require("../middleware/uploadMiddleware");

const { isAuthenticated, isAccountAllowed, isVerified } = require("../middleware/authMiddleware");
const { attachOptionalEmployerContext } = require("../middleware/employerMiddleware");

router.get(
  "/account/settings",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  attachOptionalEmployerContext,
  accountController.getSettings
);

router.post(
  "/account/settings/profile/update",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postUpdateProfile
);

router.post(
  "/account/settings/password/update",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postUpdatePassword
);

router.post(
  "/account/settings/profile/photo",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  uploadUserPhoto.single("photo"),
  accountController.postUpdateProfilePhoto
);

router.post(
  "/account/settings/email/send-change-otp",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postSendChangeEmailOTP
);

router.post(
  "/account/settings/email/confirm",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postConfirmEmailChange
);

router.post(
  "/account/settings/2fa/send-enable-otp",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postSendEnableTwoFactorOTP
);

router.post(
  "/account/settings/2fa/enable",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postEnableTwoFactor
);

router.post(
  "/account/settings/2fa/send-disable-otp",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postSendDisableTwoFactorOTP
);

router.post(
  "/account/settings/2fa/disable",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  accountController.postDisableTwoFactor
);

module.exports = router;
