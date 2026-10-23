// controllers/authController.js

const AuthService = require("../services/authService");
const InviteService = require("../services/inviteService");
const logger = require("../utils/logger");

const { getPostAuthRedirect } = require("../utils/routeHelper");

const { saveSession, loginUserToRequest, getSessionUser } = require("../utils/sessionHelper");

const getInviteTokenFromRequest = (req) => {
  return String(req.body?.inviteToken || req.query?.inviteToken || "").trim();
};

//─────────────────────────────── AUTH RENDER BLOCK (GET ROUTES) ───────────────────────────────//

// Render Login Page
exports.getLogin = async (req, res, next) => {
  try {
    const loginView = await InviteService.getLoginInviteContext(req.query.inviteToken);

    return res.render("auth/login", {
      layout: "layouts/auth-layout",
      title: loginView.pageTitle,
      csrfToken: req.csrfToken(),

      loginView,

      scripts: `
        <script src="/js/auth/login.js"></script>
      `,
    });
  } catch (error) {
    return next(error);
  }
};

// Render Signup Page
exports.getSignup = async (req, res, next) => {
  try {
    const signupView = await InviteService.getSignupInviteContext(req.query.inviteToken);

    return res.render("auth/signup", {
      layout: "layouts/auth-layout",
      title: signupView.pageTitle,
      csrfToken: req.csrfToken(),

      signupView,

      scripts: `
        <script src="/js/auth/signup.js"></script>
      `,
    });
  } catch (error) {
    return next(error);
  }
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

  return res.render("auth/two-factor", {
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
exports.postLogin = async (req, res) => {
  try {
    const inviteToken = getInviteTokenFromRequest(req);

    const result = await AuthService.loginUser(req.body);

    if (result.requiresEmailVerification) {
      await AuthService.sendOTP(result.pendingAuth.userId);

      req.session.otpContext = {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "email_verification",
        inviteToken: inviteToken || null,
      };

      await saveSession(req);

      return res.json({
        success: true,
        message: "Please verify your email with the OTP sent to you.",
        redirectUrl: "/two-factor",
      });
    }

    if (result.requiresTwoFactor) {
      await AuthService.sendOTP(result.pendingAuth.userId);

      req.session.otpContext = {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "login_2fa",
        inviteToken: inviteToken || null,
      };

      await saveSession(req);

      return res.json({
        success: true,
        message: "Enter the OTP sent to your email.",
        redirectUrl: "/two-factor",
      });
    }

    await loginUserToRequest(req, result.user);

    let authenticatedUser = result.user;
    let redirectUrl = getPostAuthRedirect(authenticatedUser);
    let message = "You have successfully logged in!";

    if (inviteToken) {
      const inviteResult = await InviteService.acceptLoginInvite({
        token: inviteToken,
        userId: authenticatedUser._id,
      });

      authenticatedUser = inviteResult.user || authenticatedUser;
      redirectUrl = inviteResult.redirectTo || getPostAuthRedirect(authenticatedUser);
      message = "You have successfully logged in and accepted the invite!";
    }

    req.session.user = getSessionUser(authenticatedUser);

    await saveSession(req);

    return res.json({
      success: true,
      message,
      redirectUrl,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Handle Signup Form
exports.postSignup = async (req, res) => {
  try {
    const inviteToken = getInviteTokenFromRequest(req);

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw new Error("Missing required fields");
    }

    // ───────────────────── INVITATION REGISTRATION ─────────────────────

    /*
     * Employer team-member invitations follow
     * their existing separate registration flow.
     *
     * The invite service establishes the invitation
     * role and permitted business membership.
     *
     * Do not replace invitation registration with
     * ordinary professional or employer onboarding.
     *
     * The first and last names collected here
     * belong to the invited account holder.
     *
     * Invitation account creation must not be used
     * to establish a professional's NIN legal name
     * or an employer's CAC registered business name.
     */

    if (inviteToken) {
      const { firstName, lastName, password, confirmPassword } = req.body;

      const result = await InviteService.acceptSignupInvite({
        token: inviteToken,
        firstName,
        lastName,
        password,
        confirmPassword,
      });

      await AuthService.sendOTP(result.pendingAuth.userId);

      req.session.otpContext = {
        userId: result.pendingAuth.userId,
        email: result.user.email,
        purpose: "signup_invite_verification",
        inviteToken: result.pendingAuth.inviteToken,
      };

      await saveSession(req);

      return res.json({
        success: true,
        message: "Account created! Please check your email for your OTP.",
        redirectUrl: "/two-factor",
      });
    }

    // ───────────────────── ORDINARY ACCOUNT REGISTRATION ─────────────────────

    /*
     * Public registration supports only
     * professional and employer accounts.
     *
     * Administrator registration is not available
     * through the public signup form.
     *
     * AuthService.registerUser independently
     * enforces the allowed account roles.
     */

    const { firstName, middleName, lastName, email, password, confirmPassword, role } = req.body;

    const cleanRole = String(role || "")
      .trim()
      .toLowerCase();

    if (!["professional", "employer"].includes(cleanRole)) {
      throw new Error("Please select a valid account type.");
    }

    if (!email || !password || !confirmPassword) {
      throw new Error("Missing required fields");
    }

    // ───────────────────── PROFESSIONAL REGISTRATION ─────────────────────

    /*
     * Professionals do not manually provide
     * legal first, middle or last names during
     * initial account registration.
     *
     * The professional account is created
     * without legal names.
     *
     * The names are populated later using
     * structured, acknowledged NIN registry
     * evidence during professional onboarding.
     *
     * This controller must not infer names
     * from displayName or accept names supplied
     * by an older or modified signup form.
     *
     * NIN registry name population does not
     * by itself establish NIN-holder authentication
     * or final professional approval.
     */

    if (cleanRole === "professional") {
      const submittedLegalName = [firstName, middleName, lastName].some(
        (value) => String(value ?? "").trim() !== ""
      );

      if (submittedLegalName) {
        throw new Error(
          "Professional registration does not accept manually entered legal names. Your legal name will be obtained through NIN verification during onboarding."
        );
      }
    }

    // ───────────────────── EMPLOYER REGISTRATION ─────────────────────

    /*
     * Employers still provide their account
     * holder's first and last names.
     *
     * These are account contact details,
     * not the registered legal business name.
     *
     * The legal business name is obtained
     * separately from trusted CAC evidence
     * during employer onboarding.
     */

    if (
      cleanRole === "employer" &&
      (typeof firstName !== "string" ||
        !firstName.trim() ||
        typeof lastName !== "string" ||
        !lastName.trim())
    ) {
      throw new Error("Missing required fields");
    }

    // ───────────────────── CREATE USER ACCOUNT ─────────────────────

    /*
     * AuthService owns account creation,
     * password processing, email uniqueness,
     * role restrictions and legal-name policy.
     *
     * Do not pass NIN, CAC, verification status
     * or administrative approval information
     * through the registration payload.
     */

    const newUser = await AuthService.registerUser({
      firstName,
      lastName,
      email,
      password,
      confirmPassword,
      role: cleanRole,
    });

    // ───────────────────── EMAIL VERIFICATION ─────────────────────

    /*
     * Email OTP verification is independent
     * of NIN, CAC, PCN and marketplace approval.
     *
     * Professional NIN lookup occurs later
     * in the authenticated onboarding flow.
     */

    await AuthService.sendOTP(newUser._id);

    req.session.otpContext = {
      userId: newUser._id,
      email: newUser.email,
      purpose: "email_verification",
      inviteToken: null,
    };

    await saveSession(req);

    return res.json({
      success: true,
      message: "Account created! Please check your email for your OTP.",
      redirectUrl: "/two-factor",
    });
  } catch (error) {
    logger.error("Signup error:", error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Verify OTP
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

    let user = await AuthService.verifyOTP(otpContext.userId, otp);

    /*
     * Account restrictions remain independent
     * of successful OTP or email verification.
     *
     * Do not establish an authenticated session
     * for an account that became suspended,
     * deactivated or banned while its OTP
     * verification was pending.
     */

    if (["suspended", "deactivated", "banned"].includes(user.accountStatus)) {
      return res.status(403).json({
        success: false,
        message: "This account is not currently permitted to sign in.",
      });
    }

    let redirectUrl = getPostAuthRedirect(user);
    let message =
      otpContext.purpose === "login_2fa"
        ? "Login verified successfully!"
        : "Email verified successfully!";

    if (otpContext.inviteToken) {
      const inviteResult = await InviteService.acceptLoginInvite({
        token: otpContext.inviteToken,
        userId: user._id,
      });

      user = inviteResult.user || user;

      redirectUrl =
        inviteResult.redirectTo || inviteResult.redirectUrl || getPostAuthRedirect(user);

      message =
        otpContext.purpose === "login_2fa"
          ? "Login verified and invite accepted successfully!"
          : "Email verified and invite accepted successfully!";
    }

    await loginUserToRequest(req, user);

    req.session.user = getSessionUser(user);

    delete req.session.otpContext;

    await saveSession(req);

    return res.json({
      success: true,
      message,
      redirectUrl,
    });
  } catch (error) {
    logger.error("OTP verification error:", error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Resend OTP
exports.postResendOTP = async (req, res) => {
  try {
    const userId = req.session.otpContext?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please sign up again.",
      });
    }

    try {
      await AuthService.sendOTP(userId);
    } catch (error) {
      logger.error(`Failed to send OTP: ${error.message}`);

      return res.status(500).json({
        success: false,
        message: "Failed to send OTP. Please try again.",
      });
    }

    return res.json({
      success: true,
      message: "A new OTP has been sent to your email.",
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Handle Reset Password Form
exports.postResetPassword = async (req, res) => {
  try {
    const { email } = req.body;

    await AuthService.sendResetLink(email);

    return res.json({
      success: true,
      message: "Password reset link sent to your email.",
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Handle New Password Form
exports.postNewPassword = async (req, res) => {
  try {
    const { token } = req.query;
    const { newPassword, confirmPassword } = req.body;

    if (!token) {
      throw new Error("Reset token is missing");
    }

    await AuthService.resetPassword(token, newPassword, confirmPassword);

    return res.json({
      success: true,
      message: "Password reset successfully!",
      redirectUrl: "/login",
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Logout
exports.logout = (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);

    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      return res.redirect("/login");
    });
  });
};
