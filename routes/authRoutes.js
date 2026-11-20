// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const passport = require("passport");

const AuthService = require("../services/authService");
const InviteService = require("../services/inviteService");
const authController = require("../controllers/authController");

const { isGuest, hasPendingAuth } = require("../middleware/authMiddleware");

const {
  requireValidGoogleOAuthState,
  authenticateGoogleCallback,
} = require("../middleware/googleOAuthMiddleware");

const { generateGoogleOAuthState, clearGoogleOAuthContext } = require("../utils/googleOAuthState");

const { getPostAuthRedirect } = require("../utils/routeHelper");

const { saveSession, getSessionUser, loginUserToRequest } = require("../utils/sessionHelper");

/* ───────────────────── PUBLIC PAGES ───────────────────── */

router.get("/login", isGuest, authController.getLogin);

router.get("/signup", isGuest, authController.getSignup);

router.get("/reset-password", authController.getResetPassword);

router.get("/new-password", authController.getNewPassword);

// Only open the OTP page when an OTP context exists.

router.get("/two-factor", hasPendingAuth, authController.getTwoFactor);

/* ───────────────────── GOOGLE OAUTH ───────────────────── */

/*
 * Start Google authentication.
 *
 * The selected signup role and invitation token
 * are stored in the user's server-side session.
 *
 * Only a random OAuth state value is sent to Google.
 *
 * A fresh attempt replaces an unfinished OAuth
 * attempt in the same session.
 */

router.get("/auth/google", isGuest, (req, res, next) => {
  try {
    const intent = typeof req.query?.intent === "string" ? req.query.intent.trim() : "";

    const role = typeof req.query?.role === "string" ? req.query.role.trim() : "";

    const inviteToken =
      typeof req.query?.inviteToken === "string" ? req.query.inviteToken.trim() : "";

    const allowedRoles = ["professional", "employer"];

    if (inviteToken.length > 512) {
      return res.redirect("/login?error=invalid_invite");
    }

    const state = generateGoogleOAuthState();

    req.session.oauthContext = {
      intent: intent === "signup" ? "signup" : "login",

      role: inviteToken ? "employer" : allowedRoles.includes(role) ? role : null,

      inviteToken: inviteToken || null,

      state,
      issuedAt: Date.now(),
    };

    /*
     * Starting another authentication flow
     * replaces an unfinished OTP context.
     */

    delete req.session.otpContext;

    req.session.save((error) => {
      if (error) {
        return next(error);
      }

      return passport.authenticate("google", {
        scope: ["profile", "email"],
        state,
      })(req, res, next);
    });
  } catch (error) {
    return next(error);
  }
});

/* ───────────────────── GOOGLE OAUTH CALLBACK ───────────────────── */

router.get(
  "/auth/google/callback",

  requireValidGoogleOAuthState,

  authenticateGoogleCallback,

  async (req, res, next) => {
    try {
      if (!req.user) {
        clearGoogleOAuthContext(req);

        await saveSession(req);

        return res.redirect("/login");
      }

      const oauthContext = req.session.oauthContext || {};

      const inviteToken = String(oauthContext.inviteToken || "").trim();

      /*
       * Restricted accounts may authenticate,
       * but they cannot accept employer invitations.
       *
       * The invitation service must also enforce
       * this independently for non-Google flows.
       */

      if (inviteToken && req.user.accountStatus !== "active") {
        clearGoogleOAuthContext(req);

        await saveSession(req);

        return res.redirect("/login?error=account_unavailable");
      }

      // ───────────────────── TWO-FACTOR AUTHENTICATION ─────────────────────

      if (req.user.twoFactorEnabled) {
        const otpPurpose = req.user.isVerified ? "login_2fa" : "email_verification";
        try {
          await AuthService.sendOTP(req.user._id, {
            purpose: otpPurpose,
            email: req.user.email,
          });
        } catch (otpError) {
          clearGoogleOAuthContext(req);

          await saveSession(req);

          return res.redirect("/login?error=otp_failed");
        }

        /*
         * Google has identified the account,
         * but the application login is incomplete.
         *
         * The OTP controller will authenticate
         * the user after OTP verification.
         */

        req.session.otpContext = {
          userId: req.user._id,
          email: req.user.email,
          purpose: otpPurpose,
          inviteToken: inviteToken || null,
        };

        clearGoogleOAuthContext(req);

        await saveSession(req);

        return res.redirect("/two-factor");
      }

      // ───────────────────── LOGIN WITHOUT TWO-FACTOR ─────────────────────

      let authenticatedUser = req.user;

      let redirectUrl = getPostAuthRedirect(authenticatedUser);

      // ───────────────────── EMPLOYER INVITATION ─────────────────────

      if (inviteToken) {
        const inviteResult = await InviteService.acceptLoginInvite({
          token: inviteToken,
          userId: authenticatedUser._id,
        });

        authenticatedUser = inviteResult.user || authenticatedUser;

        redirectUrl =
          inviteResult.redirectTo ||
          inviteResult.redirectUrl ||
          getPostAuthRedirect(authenticatedUser);
      }

      // ───────────────────── ESTABLISH LOGIN SESSION ─────────────────────

      await loginUserToRequest(req, authenticatedUser);

      req.session.user = getSessionUser(authenticatedUser);

      clearGoogleOAuthContext(req);

      delete req.session.otpContext;

      await saveSession(req);

      return res.redirect(redirectUrl);
    } catch (error) {
      return next(error);
    }
  }
);

/* ───────────────────── AUTHENTICATION ACTIONS ───────────────────── */

router.post("/login", authController.postLogin);

router.post("/signup", authController.postSignup);

/* ───────────────────── TWO-FACTOR AUTHENTICATION ───────────────────── */

router.post("/two-factor/verify", authController.postVerifyOTP);

router.post("/two-factor/resend", authController.postResendOTP);

/* ───────────────────── PASSWORD RECOVERY ───────────────────── */

router.post("/reset-password", authController.postResetPassword);

router.post("/new-password", authController.postNewPassword);

/* ───────────────────── LOGOUT ───────────────────── */

router.post("/logout", authController.logout);

module.exports = router;
