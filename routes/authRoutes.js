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
router.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    // Successful Google login
    res.redirect(`/dashboard/${req.user.role}`);
  }
);

/* ---------- Action pages (POST}) ---------- */
router.post("/login", authController.postLogin);
router.post("/signup", authController.postSignup);
router.post("/two-factor/verify", hasPendingAuth, authController.postVerifyOTP);
router.post("/two-factor/resend", hasPendingAuth, authController.postResendOTP);
router.post("/reset-password", authController.postResetPassword);
router.post("/new-password", authController.postNewPassword);

module.exports = router;
