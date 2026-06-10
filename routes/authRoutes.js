// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const passport = require("passport");

const AuthService = require("../services/authService");
const authController = require("../controllers/authController");

const { isGuest, hasPendingAuth } = require("../middleware/authMiddleware");

const { getHomeRoute, getOnboardingRoute } = require("../utils/routeHelper");

/* ---------- Public pages (GET) ---------- */
router.get("/login", isGuest, authController.getLogin);
router.get("/signup", isGuest, authController.getSignup);
router.get("/reset-password", authController.getResetPassword);
router.get("/new-password", authController.getNewPassword);
router.get("/two-factor", hasPendingAuth, authController.getTwoFactor);

/* ---------- Google OAuth ---------- */
router.get("/auth/google", (req, res, next) => {
  const { intent, role } = req.query;

  const allowedRoles = ["professional", "employer"];

  req.session.oauthContext = {
    intent: intent === "signup" ? "signup" : "login",
    role: allowedRoles.includes(role) ? role : null,
  };

  req.session.save((err) => {
    if (err) return next(err);

    passport.authenticate("google", {
      scope: ["profile", "email"],
    })(req, res, next);
  });
});

router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  async (req, res, next) => {
    try {
      if (!req.user) {
        return res.redirect("/login");
      }

      if (req.user.twoFactorEnabled) {
        await AuthService.sendOTP(req.user._id);

        const pendingUser = {
          userId: req.user._id,
          email: req.user.email,
        };

        req.logout((err) => {
          if (err) return next(err);

          req.session.otpContext = {
            userId: pendingUser.userId,
            email: pendingUser.email,
            purpose: "login_2fa",
          };

          return req.session.save((err) => {
            if (err) return next(err);

            return res.redirect("/two-factor");
          });
        });

        return;
      }

      req.session.user = {
        _id: req.user._id,
        email: req.user.email,
        role: req.user.role,
        isVerified: req.user.isVerified,
        isOnboarded: req.user.isOnboarded,
        twoFactorEnabled: req.user.twoFactorEnabled,
      };

      return req.session.save((err) => {
        if (err) return next(err);

        if (req.user.role === "admin") {
          return res.redirect(getHomeRoute(req.user.role));
        }

        if (!req.user.isOnboarded) {
          return res.redirect(getOnboardingRoute(req.user.role));
        }

        return res.redirect(getHomeRoute(req.user.role));
      });
    } catch (error) {
      return next(error);
    }
  }
);

/* ---------- Action pages (POST) ---------- */
router.post("/login", authController.postLogin);
router.post("/signup", authController.postSignup);
router.post("/two-factor/verify", hasPendingAuth, authController.postVerifyOTP);
router.post("/two-factor/resend", hasPendingAuth, authController.postResendOTP);
router.post("/reset-password", authController.postResetPassword);
router.post("/new-password", authController.postNewPassword);
router.post("/logout", authController.logout);

module.exports = router;
