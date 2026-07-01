// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const passport = require("passport");

const AuthService = require("../services/authService");
const InviteService = require("../services/inviteService");
const authController = require("../controllers/authController");

const { isGuest, hasPendingAuth } = require("../middleware/authMiddleware");

const { getPostAuthRedirect } = require("../utils/routeHelper");

const {
  saveSession,
  destroySessionAndRedirect,
  getSessionUser,
  loginUserToRequest,
} = require("../utils/sessionHelper");

/* ---------- Public pages (GET) ---------- */

router.get("/login", isGuest, authController.getLogin);
router.get("/signup", isGuest, authController.getSignup);
router.get("/reset-password", authController.getResetPassword);
router.get("/new-password", authController.getNewPassword);

// Keep this here because the page itself should only open when OTP context exists.
router.get("/two-factor", hasPendingAuth, authController.getTwoFactor);

/* ---------- Google OAuth ---------- */

router.get("/auth/google", (req, res, next) => {
  const intent = String(req.query.intent || "").trim();
  const role = String(req.query.role || "").trim();
  const inviteToken = String(req.query.inviteToken || "").trim();

  const allowedRoles = ["professional", "employer"];

  req.session.oauthContext = {
    intent: intent === "signup" ? "signup" : "login",
    role: inviteToken ? "employer" : allowedRoles.includes(role) ? role : null,
    inviteToken: inviteToken || null,
  };

  req.session.save((err) => {
    if (err) return next(err);

    return passport.authenticate("google", {
      scope: ["profile", "email"],
    })(req, res, next);
  });
});

router.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
    session: false,
  }),
  async (req, res, next) => {
    try {
      if (!req.user) {
        return res.redirect("/login");
      }

      const oauthContext = req.session.oauthContext || {};
      const inviteToken = String(oauthContext.inviteToken || "").trim();

      if (req.user.twoFactorEnabled) {
        try {
          await AuthService.sendOTP(req.user._id);
        } catch (otpError) {
          delete req.session.oauthContext;
          await saveSession(req);

          return res.redirect("/login?error=otp_failed");
        }

        req.session.otpContext = {
          userId: req.user._id,
          email: req.user.email,
          purpose: "login_2fa",
          inviteToken: inviteToken || null,
        };

        delete req.session.oauthContext;

        await saveSession(req);

        return res.redirect("/two-factor");
      }

      let authenticatedUser = req.user;
      let redirectUrl = getPostAuthRedirect(authenticatedUser);

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

      await loginUserToRequest(req, authenticatedUser);

      req.session.user = getSessionUser(authenticatedUser);

      delete req.session.oauthContext;

      await saveSession(req);

      return res.redirect(redirectUrl);
    } catch (error) {
      return next(error);
    }
  }
);

/* ---------- Action pages (POST) ---------- */

router.post("/login", authController.postLogin);
router.post("/signup", authController.postSignup);

router.post("/two-factor/verify", authController.postVerifyOTP);
router.post("/two-factor/resend", authController.postResendOTP);

router.post("/reset-password", authController.postResetPassword);
router.post("/new-password", authController.postNewPassword);

router.post("/logout", authController.logout);

module.exports = router;
