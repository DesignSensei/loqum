// controllers/authController.js

const User = require("../models/User");
const AuthService = require("../services/authService");
const logger = require("../utils/logger");

const { getHomeRoute, getOnboardingRoute } = require("../utils/routeHelper");

const getPostAuthRedirect = (user) => {
  if (!user.isOnboarded) {
    return getOnboardingRoute(user.role);
  }

  return getHomeRoute(user.role);
};

//─────────────────────────────── AUTH RENDER BLOCK (GET ROUTES) ───────────────────────────────//
// Render Login Page
exports.getLogin = (req, res) => {
  res.render("auth/login", {
    layout: "layouts/auth-layout",
    title: "Log In",
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/auth/login.js"></script>
    `,
  });
};

// Render Signup Page
exports.getSignup = (req, res) => {
  res.render("auth/signup", {
    layout: "layouts/auth-layout",
    title: "Sign Up",
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/auth/signup.js"></script>
    `,
  });
};

// Render Reset Password Page
exports.getResetPassword = (req, res) => {
  res.render("auth/reset-password", {
    layout: "layouts/auth-layout-no-index",
    title: "Reset Password",
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="assets/js/custom/authentication/reset-password/reset-password.js"></script>
    <script src="/js/auth/reset-password.js"></script>
    `,
  });
};

// Render New Password Page
exports.getNewPassword = (req, res) => {
  res.render("auth/new-password", {
    layout: "layouts/auth-layout-no-index",
    title: "New Password",
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="assets/js/custom/authentication/reset-password/new-password.js"></script>
    <script src="/js/auth/new-password.js"></script>
    `,
  });
};

// Render Two Factor Page
exports.getTwoFactor = (req, res) => {
  const otpContext = req.session.otpContext;

  if (!otpContext || !otpContext.email) {
    return res.redirect("/login");
  }

  res.render("auth/two-factor", {
    layout: "layouts/auth-layout-no-index",
    title: "Two Factor",
    csrfToken: req.csrfToken(),
    scripts: `
      <script src="/js/auth/two-factor.js"></script>
    `,
    user: {
      email: otpContext.email,
    },
  });
};

//─────────────────────────────── AUTH ACTIONS (POST ROUTES) ───────────────────────────────//

// Handle Login Form
exports.postLogin = async (req, res, next) => {
  try {
    const result = await AuthService.loginUser(req.body);

    if (result.requiresEmailVerification) {
      await AuthService.sendOTP(result.pendingAuth.userId);

      req.session.otpContext = {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "email_verification",
      };

      return req.session.save((err) => {
        if (err) return next(err);

        return res.json({
          success: true,
          message: "Please verify your email with the OTP sent to you.",
          redirectUrl: "/two-factor",
        });
      });
    }

    if (result.requiresTwoFactor) {
      await AuthService.sendOTP(result.pendingAuth.userId);

      req.session.otpContext = {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "login_2fa",
      };

      return req.session.save((err) => {
        if (err) return next(err);

        return res.json({
          success: true,
          message: "Enter the OTP sent to your email.",
          redirectUrl: "/two-factor",
        });
      });
    }

    return req.login(result.user, (err) => {
      if (err) return next(err);

      req.session.user = {
        _id: result.user._id,
        email: result.user.email,
        role: result.user.role,
        isVerified: result.user.isVerified,
        isOnboarded: result.user.isOnboarded,
        twoFactorEnabled: result.user.twoFactorEnabled,
      };

      return req.session.save((err) => {
        if (err) return next(err);

        return res.json({
          success: true,
          message: "You have successfully logged in!",
          redirectUrl: getPostAuthRedirect(result.user),
        });
      });
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Handle Signup Form
exports.postSignup = async (req, res, next) => {
  try {
    // Check if req.body is not undefined or empty
    if (
      !req.body ||
      !req.body.firstName ||
      !req.body.lastName ||
      !req.body.email ||
      !req.body.password ||
      !req.body.confirmPassword ||
      !req.body.role
    ) {
      throw new Error("Missing required fields");
    }

    const { firstName, lastName, email, password, confirmPassword, role } = req.body;

    const newUser = await AuthService.registerUser({
      firstName,
      lastName,
      email,
      password,
      confirmPassword,
      role,
    });

    // Send OTP
    await AuthService.sendOTP(newUser._id);

    req.session.otpContext = {
      userId: newUser._id,
      email: newUser.email,
      purpose: "email_verification",
    };

    req.session.save((err) => {
      if (err) return next(err);
      res.json({
        success: true,
        message: "Account created! Please check your email for your OTP.",
        redirectUrl: "/two-factor",
      });
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.postVerifyOTP = async (req, res, next) => {
  try {
    const { otp } = req.body;
    const otpContext = req.session.otpContext;

    if (!otpContext || !otpContext.userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please try again.",
      });
    }

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "OTP is required",
      });
    }

    const user = await AuthService.verifyOTP(otpContext.userId, otp);

    req.login(user, (err) => {
      if (err) return next(err);

      req.session.user = {
        _id: user._id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        isOnboarded: user.isOnboarded,
        twoFactorEnabled: user.twoFactorEnabled,
      };

      const purpose = otpContext.purpose;

      delete req.session.otpContext;

      const redirectUrl = getPostAuthRedirect(user);

      req.session.save((err) => {
        if (err) return next(err);

        return res.json({
          success: true,
          message:
            purpose === "email_verification"
              ? "Email verified successfully!"
              : "Login verified successfully!",
          redirectUrl,
        });
      });
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.postResendOTP = async (req, res, next) => {
  try {
    const userId = req.session.otpContext?.userId;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please sign up again.",
      });

    try {
      await AuthService.sendOTP(userId);
    } catch (error) {
      logger.error(`Failed to send OTP: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: "Failed to send OTP. Please try again.",
      });
    }

    res.json({
      success: true,
      message: "A new OTP has been sent to your email.",
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Handle Reset Password Form
exports.postResetPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    await AuthService.sendResetLink(email);
    return res.json({
      success: true,
      message: "Password reset link sent to your email.",
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Handle New Password Form
exports.postNewPassword = async (req, res, next) => {
  try {
    const { token } = req.query;
    const { newPassword, confirmPassword } = req.body;

    if (!token) throw new Error("Reset token is missing");

    await AuthService.resetPassword(token, newPassword, confirmPassword);
    return res.json({
      success: true,
      message: "Password reset successfully!",
      redirectUrl: "/login",
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.logout = (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);

    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/login");
    });
  });
};
