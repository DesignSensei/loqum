// controllers/authController.js

const AuthService = require("../services/authService");
const InviteService = require("../services/inviteService");
const logger = require("../utils/logger");

const { getPostAuthRedirect } = require("../utils/routeHelper");

const { saveSession, loginUserToRequest, getSessionUser } = require("../utils/sessionHelper");

const getInviteTokenFromRequest = (req) => {
  const token = req.body?.inviteToken ?? req.query?.inviteToken ?? "";
  if (typeof token !== "string") throw new Error("Invalid invitation token.");
  return token.trim();
};

// ───────────────────── AUTH RESPONSE HELPERS ─────────────────────

const validOTPContext = (context) =>
  Boolean(
    context?.userId &&
    typeof context.email === "string" &&
    context.email &&
    ["email_verification", "login_2fa", "signup_invite_verification"].includes(context.purpose)
  );

const sendAuthError = (res, error) => {
  const conflict = error.name === "VersionError";
  return res.status(conflict ? 409 : error.statusCode || 400).json({
    success: false,
    message: conflict
      ? "Your account changed during this request. Please refresh and try again."
      : error.message,
    ...(error.redirectUrl ? { redirectUrl: error.redirectUrl } : {}),
  });
};

const sendPendingOTP = async (req, context) => {
  // Keep a usable resend context even when delivery fails after account creation.
  req.session.otpContext = context;
  await saveSession(req);
  try {
    await AuthService.sendOTP(context.userId, {
      purpose: context.purpose,
      email: context.email,
    });
  } catch (error) {
    const cooldown = /wait 60 seconds/i.test(error.message || "");
    const blocked = /not currently permitted to sign in/i.test(error.message || "");
    throw Object.assign(
      new Error(
        cooldown || blocked
          ? error.message
          : "OTP delivery failed. Please try resending from the verification page."
      ),
      {
        statusCode: cooldown ? 429 : blocked ? 403 : 503,
        redirectUrl: "/two-factor",
      }
    );
  }
};

const acceptOptionalInvite = async (user, token) => {
  if (!token) return { user, accepted: false, failed: false };
  try {
    const result = await InviteService.acceptLoginInvite({ token, userId: user._id });
    const updatedUser = result.user || user;
    if (String(updatedUser._id) !== String(user._id)) throw new Error("Invitation user mismatch");
    return {
      user: updatedUser,
      accepted: true,
      failed: false,
      redirectUrl: result.redirectTo || result.redirectUrl,
    };
  } catch (_) {
    // Authentication succeeded independently. Do not expose invite/provider
    // internals or require reuse of an OTP that has already been consumed.
    logger.error("Invite acceptance failed after successful authentication.");
    return { user, accepted: false, failed: true };
  }
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
      <script src="/js/auth/new-password.js"></script>
    `,
  });
};

// Render Two Factor Page
exports.getTwoFactor = (req, res) => {
  const otpContext = req.session.otpContext;

  if (!validOTPContext(otpContext)) {
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

    const { email, password } = req.body || {};
    const result = await AuthService.loginUser({ email, password });

    if (result.requiresEmailVerification) {
      await sendPendingOTP(req, {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "email_verification",
        inviteToken: inviteToken || null,
      });

      return res.json({
        success: true,
        message: "Please verify your email with the OTP sent to you.",
        redirectUrl: "/two-factor",
      });
    }

    if (result.requiresTwoFactor) {
      await sendPendingOTP(req, {
        userId: result.pendingAuth.userId,
        email: result.pendingAuth.email,
        purpose: "login_2fa",
        inviteToken: inviteToken || null,
      });

      return res.json({
        success: true,
        message: "Enter the OTP sent to your email.",
        redirectUrl: "/two-factor",
      });
    }

    const invite = await acceptOptionalInvite(result.user, inviteToken);
    const authenticatedUser = invite.user;
    if (!["active", "restricted"].includes(authenticatedUser.accountStatus)) {
      throw Object.assign(new Error("This account is not currently permitted to sign in."), {
        statusCode: 403,
      });
    }
    const redirectUrl = invite.redirectUrl || getPostAuthRedirect(authenticatedUser);
    const message = invite.failed
      ? "You have logged in, but the invitation could not be accepted. Please contact the inviter."
      : invite.accepted
        ? "You have successfully logged in and accepted the invite!"
        : "You have successfully logged in!";
    await loginUserToRequest(req, authenticatedUser);
    delete req.session.otpContext;

    req.session.user = getSessionUser(authenticatedUser);

    await saveSession(req);

    return res.json({
      success: true,
      message,
      redirectUrl,
    });
  } catch (error) {
    return sendAuthError(res, error);
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

      await sendPendingOTP(req, {
        userId: result.pendingAuth.userId,
        email: result.user.email,
        purpose: "signup_invite_verification",
        inviteToken: result.pendingAuth.inviteToken,
      });

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
        (value) => value != null && (typeof value !== "string" || value.trim() !== "")
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
      middleName,
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

    await sendPendingOTP(req, {
      userId: newUser._id,
      email: newUser.email,
      purpose: "email_verification",
      inviteToken: null,
    });

    return res.json({
      success: true,
      message: "Account created! Please check your email for your OTP.",
      redirectUrl: "/two-factor",
    });
  } catch (error) {
    logger.error("Signup failed.", { name: error.name, code: error.code });

    return sendAuthError(res, error);
  }
};

// Verify OTP
exports.postVerifyOTP = async (req, res, next) => {
  try {
    const { otp } = req.body || {};
    const otpContext = req.session.otpContext;

    if (!validOTPContext(otpContext)) {
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

    let user = await AuthService.verifyOTP(otpContext.userId, otp, {
      purpose: otpContext.purpose,
      email: otpContext.email,
    });
    if (String(user._id) !== String(otpContext.userId) || user.email !== otpContext.email) {
      throw Object.assign(new Error("Your verification context changed. Please sign in again."), {
        statusCode: 409,
      });
    }

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

    const invite = await acceptOptionalInvite(user, otpContext.inviteToken);
    user = invite.user;
    if (!["active", "restricted"].includes(user.accountStatus)) {
      throw Object.assign(new Error("This account is not currently permitted to sign in."), {
        statusCode: 403,
      });
    }
    const redirectUrl = invite.redirectUrl || getPostAuthRedirect(user);
    const message = invite.failed
      ? "Verification succeeded, but the invitation could not be accepted. Please contact the inviter."
      : invite.accepted
        ? "Verification succeeded and invite accepted successfully!"
        : otpContext.purpose === "login_2fa"
          ? "Login verified successfully!"
          : "Email verified successfully!";

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
    logger.error("OTP verification failed.", { name: error.name, code: error.code });

    return sendAuthError(res, error);
  }
};

// Resend OTP
exports.postResendOTP = async (req, res) => {
  try {
    const context = req.session.otpContext;
    if (!validOTPContext(context)) {
      return res
        .status(401)
        .json({ success: false, message: "Session expired. Please sign in again." });
    }
    await sendPendingOTP(req, context);

    return res.json({
      success: true,
      message: "A new OTP has been sent to your email.",
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
};

// Handle Reset Password Form
exports.postResetPassword = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (typeof email !== "string" || !email.trim()) throw new Error("Enter a valid email address.");

    await AuthService.sendResetLink(email);

    return res.json({
      success: true,
      message: "Password reset link sent to your email.",
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
};

// Handle New Password Form
exports.postNewPassword = async (req, res) => {
  try {
    const { token } = req.query;
    const { newPassword, confirmPassword } = req.body || {};

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
    return sendAuthError(res, error);
  }
};

// Logout
exports.logout = (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);

    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("connect.sid");
      return res.redirect("/login");
    });
  });
};
