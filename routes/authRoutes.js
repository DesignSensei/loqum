// routes/authRoutes.js

const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

/* ---------- Public pages (GET) ---------- */
router.get("/login", authController.getLogin);
router.get("/signup", authController.getSignup);
router.get("/reset-password", authController.getResetPassword);
router.get("/new-password", authController.getNewPassword);
router.get("/two-factor", authController.getTwoFactor);

/* ---------- Action pages (POST}) ---------- */
router.post("/login", authController.postLogin);
router.post("/signup", authController.postSignup);
router.post("/two-factor/verify", authController.postVerifyOTP);
router.post("/two-factor/resend", authController.postResendOTP);

module.exports = router;
