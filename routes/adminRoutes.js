// routes/adminRoutes.js

const express = require("express");
const router = express.Router();

const {
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole,
} = require("../middleware/authMiddleware");

const adminController = require("../controllers/adminController");

/* ---------- Middleware ---------- */
router.use(isAuthenticated, isVerified, isAccountAllowed, hasRole("admin"));

/* ---------- Admin pages (GET) ---------- */
router.get("/dashboard", adminController.getDashboard);

module.exports = router;
