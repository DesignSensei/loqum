// routes/adminRoutes.js

const express = require("express");
const router = express.Router();
const { isAuthenticated, isVerified, hasRole } = require("../middleware/authMiddleware");
const adminController = require("../controllers/adminController");

/* ---------- Middleware ---------- */
// router.use(isAuthenticated, isVerified, hasRole("admin"));

/* ---------- Public pages (GET) ---------- */
router.get("/dashboard", adminController.getDashboard);

module.exports = router;
