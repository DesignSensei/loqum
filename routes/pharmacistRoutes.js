// routes/pharmacistRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");
const pharmacistController = require("../controllers/pharmacistController");

/* ---------- Middleware ---------- */
router.use(isAuthenticated, isVerified, hasRole("pharmacist"), isOnboarded);

/* ---------- Public pages (GET) ---------- */
router.get("/dashboard", pharmacistController.getDashboard);

module.exports = router;
