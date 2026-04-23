// routes/professionalRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");
const professionalController = require("../controllers/professionalController");

/* ---------- Middleware ---------- */
// router.use(isAuthenticated, isVerified, hasRole("worker"), isOnboarded);

/* ---------- Public pages (GET) ---------- */
router.get("/dashboard", professionalController.getDashboard);

module.exports = router;
