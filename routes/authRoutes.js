// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const passport = require("passport");
const { isGuest, hasPendingAuth } = require("../middleware/authMiddleware");
const authController = require("../controllers/authController");

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
  (req, res, next) => {
    if (!req.user) {
      return res.redirect("/login");
    }

    req.session.user = {
      _id: req.user._id,
      email: req.user.email,
      role: req.user.role,
      isVerified: req.user.isVerified,
      isOnboarded: req.user.isOnboarded,
    };

    req.session.save((err) => {
      if (err) return next(err);

      if (!req.user.role || !req.user.isOnboarded) {
        return res.redirect(`/${req.user.role}/onboarding`);
      }

      return res.redirect(`/${req.user.role}/dashboard`);
    });
  }
);

/* ---------- Action pages (POST}) ---------- */
router.post("/login", authController.postLogin);
router.post("/signup", authController.postSignup);
router.post("/two-factor/verify", hasPendingAuth, authController.postVerifyOTP);
router.post("/two-factor/resend", hasPendingAuth, authController.postResendOTP);
router.post("/reset-password", authController.postResetPassword);
router.post("/new-password", authController.postNewPassword);
router.post("/logout", authController.logout);

module.exports = router;
