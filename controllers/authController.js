const User = require("../models/User");
const AuthService = require("../services/authService");
const logger = require("../utils/logger");

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
  const user = req.session.user || {};

  if (!user.email) {
    return res.redirect("/login");
  }

  res.render("auth/two-factor", {
    layout: "layouts/auth-layout-no-index",
    title: "Two Factor",
    scripts: `
    <script src="/js/auth/two-factor.js"></script>
    `,
    user: user,
  });
};

//─────────────────────────────── AUTH ACTIONS (POST ROUTES) ───────────────────────────────//

// Handle Login Form
exports.postLogin = async (req, res, next) => {
  try {
    const result = await AuthService.loginUser(req.body);

    if (result.requiresTwoFactor) {
      req.session.pendingAuth = result.pendingAuth;
      return res.redirect("/two-factor");
    }

    req.session.user = result.user;
    return res.json({
      success: true,
      message: "You have successfully logged in!",
      redirectUrl: "/dashboard",
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

    const { firstName, lastName, email, password, confirmPassword, role } =
      req.body;

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

    req.session.user = newUser;

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
    const userId = req.session.user?._id;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please try again.",
      });

    if (!otp)
      return res
        .status(400)
        .json({ success: false, message: "OTP is required" });

    const user = await AuthService.verifyOTP(userId, otp);

    // Let Passport serialize the user into the session
    req.login(user, (err) => {
      if (err) return next(err);

      res.json({
        success: true,
        message: "Email verified successfully!",
        redirectUrl: "/dashboard",
      });
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.postResendOTP = async (req, res, next) => {
  try {
    const userId = req.session.user?._id;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please sign up again.",
      });

    try {
      await AuthService.sendOTP(userId);
    } catch (error) {
      logger.error(`Failed to send OTP: ${otpError.message}`);
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
